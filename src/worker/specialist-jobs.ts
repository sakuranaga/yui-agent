import { setTimeout as sleep } from "node:timers/promises";
import { and, asc, eq, sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks, type Task } from "@/db/schema";
import { runSpecialistTask } from "@/lib/jobs/dispatcher";

const ENABLED = process.env.WORKER_SPECIALIST_ENABLED !== "0";
const POLL_INTERVAL_MS = Number(process.env.WORKER_SPECIALIST_POLL_INTERVAL_MS ?? 2_000);
const IDLE_LOG_INTERVAL_MS = Number(process.env.WORKER_SPECIALIST_IDLE_LOG_INTERVAL_MS ?? 60_000);

export type SpecialistJobLoop = {
  started: boolean;
};

async function claimNextSpecialistTask(): Promise<Task | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(tasks)
      .where(
        and(
          eq(tasks.taskType, "specialist_query"),
          eq(tasks.status, "pending"),
          drizzleSql`${tasks.input}->>'yuiToolName' IS NOT NULL`,
        ),
      )
      .orderBy(asc(tasks.createdAt), asc(tasks.id))
      .limit(1)
      .for("update", { skipLocked: true });

    if (!row) return null;

    const [claimed] = await tx
      .update(tasks)
      .set({ status: "running", startedAt: new Date() })
      .where(and(eq(tasks.id, row.id), eq(tasks.status, "pending")))
      .returning();

    return claimed ?? null;
  });
}

async function runOneClaimedTask(row: Task): Promise<void> {
  try {
    await runSpecialistTask(row);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[worker:specialist] task ${row.id} failed before runner completion:`, msg);
    await db
      .update(tasks)
      .set({
        status: "failed",
        completedAt: new Date(),
        error: msg,
      })
      .where(eq(tasks.id, row.id));
  }
}

export function startSpecialistJobLoop(opts: { shouldStop: () => boolean }): SpecialistJobLoop {
  if (!ENABLED) {
    console.log("[worker:specialist] disabled by WORKER_SPECIALIST_ENABLED=0");
    return { started: false };
  }

  void (async () => {
    let lastIdleLogAt = 0;
    console.log(`[worker:specialist] loop started poll=${POLL_INTERVAL_MS}ms`);

    while (!opts.shouldStop()) {
      try {
        const row = await claimNextSpecialistTask();
        if (row) {
          console.log(`[worker:specialist] claimed task ${row.id} agent=${row.agentName}`);
          await runOneClaimedTask(row);
          continue;
        }

        const now = Date.now();
        if (now - lastIdleLogAt > IDLE_LOG_INTERVAL_MS) {
          lastIdleLogAt = now;
          console.log("[worker:specialist] idle");
        }
      } catch (e) {
        console.warn("[worker:specialist] loop error:", e);
      }
      await sleep(POLL_INTERVAL_MS);
    }

    console.log("[worker:specialist] loop stopped");
  })();

  return { started: true };
}
