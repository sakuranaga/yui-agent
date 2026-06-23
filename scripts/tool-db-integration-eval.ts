import { sql } from "@/db/client";

type CountRow = { count: number | string | bigint };

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  return 0;
}

async function count(query: Promise<CountRow[]>): Promise<number> {
  const rows = await query;
  return toNumber(rows[0]?.count);
}

function printRows(label: string, rows: Array<Record<string, unknown>>) {
  console.log(`${label}: ${rows.length}`);
  for (const row of rows.slice(0, 10)) {
    console.log(`- ${JSON.stringify(row)}`);
  }
}

async function main() {
  const windowHours = Number(process.env.TOOL_DB_EVAL_HOURS ?? 24);
  const requireConfirm = process.env.TOOL_DB_EVAL_REQUIRE_CONFIRM === "1";
  let failed = 0;

  const recentConfirmCount = await count(sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM tasks
    WHERE output ? 'confirmFinal'
      AND created_at >= now() - (${windowHours} || ' hours')::interval
  `);

  const malformedConfirm = await sql<
    Array<{ id: number; session_id: string | null; confirm_final: unknown }>
  >`
    SELECT id, session_id, output->'confirmFinal' AS confirm_final
    FROM tasks
    WHERE output ? 'confirmFinal'
      AND created_at >= now() - (${windowHours} || ' hours')::interval
      AND (
        output->'confirmFinal'->>'token' IS NULL
        OR output->'confirmFinal'->>'toolName' IS NULL
        OR output->'confirmFinal'->>'success' IS NULL
        OR output->'confirmFinal'->>'state' IS NULL
        OR (
          output->'confirmFinal'->>'success' = 'true'
          AND (
            output->'confirmFinal'->'result' IS NULL
            OR output->'confirmFinal'->'result' = 'null'::jsonb
          )
        )
      )
    ORDER BY id DESC
    LIMIT 20
  `;

  const duplicateConfirmTokens = await sql<
    Array<{ token: string; count: number | string | bigint; task_ids: string }>
  >`
    SELECT
      output->'confirmFinal'->>'token' AS token,
      COUNT(*)::int AS count,
      string_agg(id::text, ',' ORDER BY id) AS task_ids
    FROM tasks
    WHERE output ? 'confirmFinal'
      AND output->'confirmFinal'->>'token' IS NOT NULL
      AND created_at >= now() - (${windowHours} || ' hours')::interval
    GROUP BY output->'confirmFinal'->>'token'
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `;

  const unsafeConfirmMessages = await sql<
    Array<{ id: number; session_id: string; content: string }>
  >`
    SELECT id, session_id, content
    FROM raw_messages
    WHERE source = 'tool_confirm_result'
      AND created_at >= now() - (${windowHours} || ' hours')::interval
      AND (
        content ~* '(confirm_token|confirmToken|token=|tool_name|toolName|input_snapshot|JSON|\\{)'
        OR content LIKE '%内部実行ログ%'
      )
    ORDER BY id DESC
    LIMIT 20
  `;

  const duplicateConfirmMessages = await sql<
    Array<{ session_id: string; content: string; count: number | string | bigint; message_ids: string }>
  >`
    SELECT
      session_id,
      content,
      COUNT(*)::int AS count,
      string_agg(id::text, ',' ORDER BY id) AS message_ids
    FROM raw_messages
    WHERE source = 'tool_confirm_result'
      AND created_at >= now() - (${windowHours} || ' hours')::interval
    GROUP BY session_id, content
    HAVING COUNT(*) > 1
    ORDER BY COUNT(*) DESC
    LIMIT 20
  `;

  console.log("Tool DB integration eval");
  console.log(`window=${windowHours}h recent_confirm_final=${recentConfirmCount}`);

  if (requireConfirm && recentConfirmCount === 0) {
    failed++;
    console.error("[ng] recent confirm final is required but none found");
  } else {
    console.log(`[ok] recent confirm final count: ${recentConfirmCount}`);
  }

  if (malformedConfirm.length > 0) {
    failed++;
    printRows("[ng] malformed confirmFinal rows", malformedConfirm);
  } else {
    console.log("[ok] malformed confirmFinal rows: 0");
  }

  if (duplicateConfirmTokens.length > 0) {
    failed++;
    printRows("[ng] duplicate confirmFinal tokens", duplicateConfirmTokens);
  } else {
    console.log("[ok] duplicate confirmFinal tokens: 0");
  }

  if (unsafeConfirmMessages.length > 0) {
    failed++;
    printRows("[ng] unsafe tool_confirm_result messages", unsafeConfirmMessages);
  } else {
    console.log("[ok] unsafe tool_confirm_result messages: 0");
  }

  if (duplicateConfirmMessages.length > 0) {
    failed++;
    printRows("[ng] duplicate tool_confirm_result messages", duplicateConfirmMessages);
  } else {
    console.log("[ok] duplicate tool_confirm_result messages: 0");
  }

  process.exitCode = failed > 0 ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 1 });
  });
