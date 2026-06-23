import { sql } from "@/db/client";

type CountRow = { count: number | string | bigint };

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  return 0;
}

function printTable(label: string, rows: Array<Record<string, unknown>>) {
  console.log(`${label}:`);
  if (rows.length === 0) {
    console.log("- none");
    return;
  }
  for (const row of rows) {
    console.log(`- ${JSON.stringify(row)}`);
  }
}

async function main() {
  const hours = Number(process.env.TOOL_OBS_HOURS ?? 24);
  const recentInterval = sql`${hours} || ' hours'`;

  const [toolTotal] = await sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM tool_execution_log
    WHERE created_at >= now() - (${recentInterval})::interval
  `;

  const toolStatus = await sql<Array<Record<string, unknown>>>`
    SELECT status, COUNT(*)::int AS count
    FROM tool_execution_log
    WHERE created_at >= now() - (${recentInterval})::interval
    GROUP BY status
    ORDER BY status
  `;

  const toolByName = await sql<Array<Record<string, unknown>>>`
    SELECT tool_name, status, COUNT(*)::int AS count
    FROM tool_execution_log
    WHERE created_at >= now() - (${recentInterval})::interval
    GROUP BY tool_name, status
    ORDER BY COUNT(*) DESC, tool_name, status
    LIMIT 30
  `;

  const confirmStates = await sql<Array<Record<string, unknown>>>`
    SELECT
      COALESCE(output->'confirmFinal'->>'state', 'missing') AS state,
      COALESCE(output->'confirmFinal'->>'success', 'missing') AS success,
      COUNT(*)::int AS count
    FROM tasks
    WHERE output ? 'confirmFinal'
      AND created_at >= now() - (${recentInterval})::interval
    GROUP BY state, success
    ORDER BY state, success
  `;

  const taskStatus = await sql<Array<Record<string, unknown>>>`
    SELECT status, COUNT(*)::int AS count
    FROM tasks
    WHERE created_at >= now() - (${recentInterval})::interval
    GROUP BY status
    ORDER BY status
  `;

  const llmByRole = await sql<Array<Record<string, unknown>>>`
    SELECT
      COALESCE(role, '(none)') AS role,
      COUNT(*)::int AS calls,
      ROUND(AVG(duration_ms))::int AS avg_ms,
      percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::int AS p50_ms,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95_ms,
      COALESCE(SUM(retries), 0)::int AS retries,
      ROUND(COALESCE(SUM(cost_usd), 0)::numeric, 6)::text AS cost_usd
    FROM llm_events
    WHERE event_type = 'call'
      AND created_at >= now() - (${recentInterval})::interval
    GROUP BY role
    ORDER BY calls DESC, role
  `;

  const gateFallbackSignals = await sql<Array<Record<string, unknown>>>`
    SELECT
      COUNT(*) FILTER (WHERE role = 'tool_gate')::int AS tool_gate_calls,
      COALESCE(SUM(retries) FILTER (WHERE role = 'tool_gate'), 0)::int AS tool_gate_retries,
      MAX(created_at) FILTER (WHERE role = 'tool_gate') AS last_tool_gate_at
    FROM llm_events
    WHERE event_type = 'call'
      AND created_at >= now() - (${recentInterval})::interval
  `;

  console.log("Tool observability report");
  console.log(`window=${hours}h tool_executions=${toNumber(toolTotal?.count)}`);
  printTable("tool status", toolStatus);
  printTable("tool by name/status", toolByName);
  printTable("confirm final states", confirmStates);
  printTable("task status", taskStatus);
  printTable("llm calls by role", llmByRole);
  printTable("gate signals", gateFallbackSignals);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 1 });
  });
