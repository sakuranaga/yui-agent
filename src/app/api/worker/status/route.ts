import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { workerHeartbeats } from "@/db/schema";

export const runtime = "nodejs";

const STALE_AFTER_MS = Number(process.env.WORKER_HEARTBEAT_STALE_AFTER_MS ?? 30_000);

export async function GET() {
  const rows = await db
    .select()
    .from(workerHeartbeats)
    .orderBy(desc(workerHeartbeats.lastSeenAt))
    .limit(20);

  const now = Date.now();
  const workers = rows.map((row) => {
    const ageMs = now - row.lastSeenAt.getTime();
    return {
      workerId: row.workerId,
      role: row.role,
      hostname: row.hostname,
      pid: row.pid,
      startedAt: row.startedAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      ageMs,
      stale: ageMs > STALE_AFTER_MS,
      metadata: row.metadata,
    };
  });

  const [queue, confirm, specialist, outbox, periodic] = await Promise.all([
    sql<Array<Record<string, unknown>>>`
      SELECT job_type, status, COUNT(*)::int AS count
      FROM background_jobs
      GROUP BY job_type, status
      ORDER BY job_type, status
    `,
    sql<Array<Record<string, unknown>>>`
      SELECT status, COUNT(*)::int AS count
      FROM tool_confirm_jobs
      GROUP BY status
      ORDER BY status
    `,
    sql<Array<Record<string, unknown>>>`
      SELECT status, COUNT(*)::int AS count
      FROM tasks
      WHERE task_type = 'specialist_query'
        AND created_at >= now() - interval '24 hours'
      GROUP BY status
      ORDER BY status
    `,
    sql<Array<Record<string, unknown>>>`
      SELECT event_type, COUNT(*)::int AS pending
      FROM events_outbox
      WHERE delivered_at IS NULL
      GROUP BY event_type
      ORDER BY pending DESC, event_type
    `,
    sql<Array<Record<string, unknown>>>`
      SELECT module_id, last_run_at, last_fired_at
      FROM periodic_state
      ORDER BY COALESCE(last_run_at, last_fired_at) DESC NULLS LAST, module_id
    `,
  ]);

  return NextResponse.json({
    ok: workers.some((worker) => worker.role === "background" && !worker.stale),
    staleAfterMs: STALE_AFTER_MS,
    workers,
    queue,
    confirm,
    specialist,
    outbox,
    periodic,
  });
}
