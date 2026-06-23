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

function line(label: string, value: number, ok: boolean, detail = "") {
  const mark = ok ? "ok" : "ng";
  const suffix = detail ? ` (${detail})` : "";
  console.log(`[${mark}] ${label}: ${value}${suffix}`);
}

async function main() {
  const pendingTimeoutMinutes = Number(process.env.TOOL_HEALTH_PENDING_MINUTES ?? 60);
  const runningTaskTimeoutMinutes = Number(process.env.TOOL_HEALTH_RUNNING_TASK_MINUTES ?? 30);
  const recentWindowMinutes = Number(process.env.TOOL_HEALTH_RECENT_MINUTES ?? 30);

  const stalePending = await count(sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM tool_execution_log
    WHERE status = 'pending_confirmation'
      AND updated_at < now() - (${pendingTimeoutMinutes} || ' minutes')::interval
  `);

  const staleRunningTasks = await count(sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM tasks
    WHERE status = 'running'
      AND COALESCE(started_at, created_at) < now() - (${runningTaskTimeoutMinutes} || ' minutes')::interval
  `);

  const recentToolFailures = await count(sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM tool_execution_log
    WHERE status = 'failed'
      AND updated_at >= now() - (${recentWindowMinutes} || ' minutes')::interval
  `);

  const recentTaskFailures = await count(sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM tasks
    WHERE status = 'failed'
      AND COALESCE(completed_at, created_at) >= now() - (${recentWindowMinutes} || ' minutes')::interval
  `);

  const livePending = await count(sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM tool_execution_log
    WHERE status = 'pending_confirmation'
  `);

  const liveExecuting = await count(sql<CountRow[]>`
    SELECT COUNT(*)::int AS count
    FROM tool_execution_log
    WHERE status = 'executing'
  `);

  const recentExecutions = await sql<
    {
      status: string;
      count: number | string | bigint;
    }[]
  >`
    SELECT status, COUNT(*)::int AS count
    FROM tool_execution_log
    WHERE created_at >= now() - (${recentWindowMinutes} || ' minutes')::interval
    GROUP BY status
    ORDER BY status
  `;

  const hasFailures =
    stalePending > 0 || staleRunningTasks > 0 || recentToolFailures > 0 || recentTaskFailures > 0;

  console.log("Tool DB health check");
  console.log(`window=${recentWindowMinutes}m pending_timeout=${pendingTimeoutMinutes}m running_task_timeout=${runningTaskTimeoutMinutes}m`);
  line("stale pending confirmations", stalePending, stalePending === 0);
  line("stale running tasks", staleRunningTasks, staleRunningTasks === 0);
  line("recent tool failures", recentToolFailures, recentToolFailures === 0);
  line("recent task failures", recentTaskFailures, recentTaskFailures === 0);
  line("live pending confirmations", livePending, true);
  line("live executing reservations", liveExecuting, true);

  if (recentExecutions.length > 0) {
    console.log("recent tool executions:");
    for (const row of recentExecutions) {
      console.log(`- ${row.status}: ${toNumber(row.count)}`);
    }
  } else {
    console.log("recent tool executions: none");
  }

  process.exitCode = hasFailures ? 1 : 0;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 1 });
  });
