import { setTimeout as sleep } from "node:timers/promises";
import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db/client";
import { toolConfirmJobs, type ToolConfirmJob } from "@/db/schema";
import { executePendingTool } from "@/lib/tools/confirm";

const ENABLED = process.env.WORKER_CONFIRM_EXECUTION_ENABLED !== "0";
const POLL_INTERVAL_MS = Number(process.env.WORKER_CONFIRM_POLL_INTERVAL_MS ?? 1_000);
const IDLE_LOG_INTERVAL_MS = Number(process.env.WORKER_CONFIRM_IDLE_LOG_INTERVAL_MS ?? 60_000);

async function claimNextConfirmJob(): Promise<ToolConfirmJob | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(toolConfirmJobs)
      .where(eq(toolConfirmJobs.status, "confirmed"))
      .orderBy(asc(toolConfirmJobs.decidedAt), asc(toolConfirmJobs.createdAt))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!row) return null;

    const [claimed] = await tx
      .update(toolConfirmJobs)
      .set({
        status: "running",
        startedAt: new Date(),
        updatedAt: new Date(),
        attempts: drizzleSql`${toolConfirmJobs.attempts} + 1`,
      })
      .where(and(eq(toolConfirmJobs.token, row.token), eq(toolConfirmJobs.status, "confirmed")))
      .returning();

    return claimed ?? null;
  });
}

async function runOneConfirmJob(row: ToolConfirmJob): Promise<void> {
  try {
    await executePendingTool(row.token);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[worker:confirm] token ${row.token} failed before controller completion:`, msg);
    await db
      .update(toolConfirmJobs)
      .set({
        status: "failed",
        lastError: msg,
        failReason: msg,
        completedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(toolConfirmJobs.token, row.token));
  }
}

export function startConfirmExecutionLoop(opts: { shouldStop: () => boolean }): void {
  if (!ENABLED) {
    console.log("[worker:confirm] disabled by WORKER_CONFIRM_EXECUTION_ENABLED=0");
    return;
  }

  void (async () => {
    let lastIdleLogAt = 0;
    console.log(`[worker:confirm] loop started poll=${POLL_INTERVAL_MS}ms`);

    while (!opts.shouldStop()) {
      try {
        const row = await claimNextConfirmJob();
        if (row) {
          console.log(`[worker:confirm] claimed token ${row.token} tool=${row.toolName}`);
          await runOneConfirmJob(row);
          continue;
        }

        const now = Date.now();
        if (now - lastIdleLogAt > IDLE_LOG_INTERVAL_MS) {
          lastIdleLogAt = now;
          console.log("[worker:confirm] idle");
        }
      } catch (e) {
        console.warn("[worker:confirm] loop error:", e);
      }
      await sleep(POLL_INTERVAL_MS);
    }

    console.log("[worker:confirm] loop stopped");
  })();
}
