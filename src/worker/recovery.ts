import { setTimeout as sleep } from "node:timers/promises";
import { and, eq, lt, sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db/client";
import { backgroundJobs, tasks, toolConfirmJobs } from "@/db/schema";
import { finalizeReservationByToken } from "@/lib/tools/dedup-guard";

const ENABLED = process.env.WORKER_RECOVERY_ENABLED !== "0";
const INTERVAL_MS = Number(process.env.WORKER_RECOVERY_INTERVAL_MS ?? 60_000);
const BACKGROUND_STALE_MS = Number(process.env.WORKER_BACKGROUND_JOB_STALE_MS ?? 15 * 60_000);
const CONFIRM_STALE_MS = Number(process.env.WORKER_CONFIRM_JOB_STALE_MS ?? 10 * 60_000);
const SPECIALIST_STALE_MS = Number(process.env.WORKER_SPECIALIST_JOB_STALE_MS ?? 30 * 60_000);
const CONFIRM_MAX_ATTEMPTS = Number(process.env.WORKER_CONFIRM_MAX_ATTEMPTS ?? 3);

function cutoff(ms: number): Date {
  return new Date(Date.now() - ms);
}

async function recoverBackgroundJobs(): Promise<number> {
  const rows = await db
    .select()
    .from(backgroundJobs)
    .where(and(eq(backgroundJobs.status, "running"), lt(backgroundJobs.lockedAt, cutoff(BACKGROUND_STALE_MS))));

  let recovered = 0;
  for (const row of rows) {
    const canRetry = row.attempts < row.maxAttempts;
    await db
      .update(backgroundJobs)
      .set({
        status: canRetry ? "pending" : "failed",
        availableAt: canRetry ? new Date() : row.availableAt,
        lastError: canRetry
          ? `recovered stale running job locked_at=${row.lockedAt?.toISOString() ?? "null"}`
          : `stale running job exceeded max attempts (${row.attempts}/${row.maxAttempts})`,
        lockedAt: null,
        lockedBy: null,
        completedAt: canRetry ? null : new Date(),
        updatedAt: new Date(),
      })
      .where(eq(backgroundJobs.id, row.id));
    recovered++;
  }
  return recovered;
}

async function recoverConfirmJobs(): Promise<number> {
  const rows = await db
    .select()
    .from(toolConfirmJobs)
    .where(
      and(
        eq(toolConfirmJobs.status, "running"),
        lt(toolConfirmJobs.startedAt, cutoff(CONFIRM_STALE_MS)),
      ),
    );

  let recovered = 0;
  for (const row of rows) {
    const reason =
      row.attempts >= CONFIRM_MAX_ATTEMPTS
        ? `confirm execution exceeded max attempts (${row.attempts}/${CONFIRM_MAX_ATTEMPTS})`
        : `confirm execution became stale after ${Math.round(CONFIRM_STALE_MS / 1000)}s`;
    await db
      .update(toolConfirmJobs)
      .set({
        status: "failed",
        failReason: reason,
        lastError: reason,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(toolConfirmJobs.token, row.token));
    try {
      await finalizeReservationByToken(row.token, "failed");
    } catch (e) {
      console.warn(`[worker:recovery] finalize confirm reservation failed token=${row.token}:`, e);
    }
    recovered++;
  }
  return recovered;
}

async function recoverSpecialistTasks(): Promise<number> {
  const rows = await db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.taskType, "specialist_query"),
        eq(tasks.status, "running"),
        lt(tasks.startedAt, cutoff(SPECIALIST_STALE_MS)),
        drizzleSql`${tasks.input}->>'yuiToolName' IS NOT NULL`,
      ),
    );

  if (rows.length === 0) return 0;
  const reason = `specialist job became stale after ${Math.round(SPECIALIST_STALE_MS / 1000)}s`;
  await db
    .update(tasks)
    .set({
      status: "failed",
      error: reason,
      completedAt: new Date(),
    })
    .where(
      and(
        eq(tasks.taskType, "specialist_query"),
        eq(tasks.status, "running"),
        lt(tasks.startedAt, cutoff(SPECIALIST_STALE_MS)),
        drizzleSql`${tasks.input}->>'yuiToolName' IS NOT NULL`,
      ),
    );
  return rows.length;
}

export async function runRecoveryOnce(): Promise<{
  background: number;
  confirm: number;
  specialist: number;
}> {
  const [background, confirm, specialist] = await Promise.all([
    recoverBackgroundJobs(),
    recoverConfirmJobs(),
    recoverSpecialistTasks(),
  ]);
  return { background, confirm, specialist };
}

export function startRecoveryLoop(opts: { shouldStop: () => boolean }): void {
  if (!ENABLED) {
    console.log("[worker:recovery] disabled by WORKER_RECOVERY_ENABLED=0");
    return;
  }

  void (async () => {
    console.log(`[worker:recovery] loop started interval=${INTERVAL_MS}ms`);
    while (!opts.shouldStop()) {
      try {
        const r = await runRecoveryOnce();
        if (r.background || r.confirm || r.specialist) {
          console.log(
            `[worker:recovery] recovered background=${r.background} confirm=${r.confirm} specialist=${r.specialist}`,
          );
        }
      } catch (e) {
        console.warn("[worker:recovery] loop error:", e);
      }
      await sleep(INTERVAL_MS);
    }
    console.log("[worker:recovery] loop stopped");
  })();
}
