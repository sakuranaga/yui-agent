import { sql } from "@/db/client";

function printRows(label: string, rows: Array<Record<string, unknown>>): void {
  console.log(`${label}:`);
  if (rows.length === 0) {
    console.log("- none");
    return;
  }
  for (const row of rows) {
    console.log(`- ${JSON.stringify(row)}`);
  }
}

async function main(): Promise<void> {
  const staleAfterSec = Number(process.env.WORKER_OBS_STALE_AFTER_SEC ?? 30);
  const windowHours = Number(process.env.WORKER_OBS_HOURS ?? 24);
  const staleInterval = sql`${staleAfterSec} || ' seconds'`;
  const windowInterval = sql`${windowHours} || ' hours'`;

  const workers = await sql<Array<Record<string, unknown>>>`
    SELECT
      worker_id,
      role,
      hostname,
      pid,
      started_at,
      last_seen_at,
      EXTRACT(EPOCH FROM (now() - last_seen_at))::int AS age_sec,
      (last_seen_at < now() - (${staleInterval})::interval) AS stale
    FROM worker_heartbeats
    ORDER BY last_seen_at DESC
    LIMIT 20
  `;

  const queueStatus = await sql<Array<Record<string, unknown>>>`
    SELECT
      job_type,
      status,
      COUNT(*)::int AS count,
      MIN(created_at) AS oldest_created_at,
      MAX(COALESCE(completed_at, started_at, created_at)) AS newest_activity_at
    FROM background_jobs
    GROUP BY job_type, status
    ORDER BY job_type, status
  `;

  const queueFailures = await sql<Array<Record<string, unknown>>>`
    SELECT
      id,
      job_type,
      status,
      attempts,
      max_attempts,
      last_error,
      updated_at
    FROM background_jobs
    WHERE status IN ('failed', 'running')
    ORDER BY updated_at DESC
    LIMIT 20
  `;

  const confirmStatus = await sql<Array<Record<string, unknown>>>`
    SELECT
      status,
      COUNT(*)::int AS count,
      MIN(created_at) AS oldest_created_at,
      MAX(COALESCE(completed_at, started_at, created_at)) AS newest_activity_at
    FROM tool_confirm_jobs
    GROUP BY status
    ORDER BY status
  `;

  const specialistStatus = await sql<Array<Record<string, unknown>>>`
    SELECT
      status,
      COUNT(*)::int AS count,
      MIN(created_at) AS oldest_created_at,
      MAX(COALESCE(completed_at, started_at, created_at)) AS newest_activity_at
    FROM tasks
    WHERE task_type = 'specialist_query'
      AND created_at >= now() - (${windowInterval})::interval
    GROUP BY status
    ORDER BY status
  `;

  const periodic = await sql<Array<Record<string, unknown>>>`
    SELECT
      module_id,
      last_run_at,
      last_fired_at,
      EXTRACT(EPOCH FROM (now() - COALESCE(last_run_at, last_fired_at)))::int AS age_sec
    FROM periodic_state
    ORDER BY COALESCE(last_run_at, last_fired_at) DESC NULLS LAST, module_id
  `;

  const outbox = await sql<Array<Record<string, unknown>>>`
    SELECT
      event_type,
      COUNT(*) FILTER (WHERE delivered_at IS NULL)::int AS pending,
      COUNT(*) FILTER (WHERE delivered_at IS NOT NULL)::int AS delivered,
      MIN(created_at) FILTER (WHERE delivered_at IS NULL) AS oldest_pending_at
    FROM events_outbox
    WHERE created_at >= now() - (${windowInterval})::interval
    GROUP BY event_type
    ORDER BY pending DESC, event_type
  `;

  console.log("Worker observability report");
  console.log(`window=${windowHours}h staleAfter=${staleAfterSec}s`);
  printRows("workers", workers);
  printRows("background queue by type/status", queueStatus);
  printRows("background failed/running recent", queueFailures);
  printRows("confirm jobs", confirmStatus);
  printRows("specialist tasks", specialistStatus);
  printRows("periodic state", periodic);
  printRows("events outbox", outbox);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 1 });
  });
