import type postgres from "postgres";
import { sql } from "@/db/client";
import { startScheduler } from "@/lib/scheduler";

const SCHEDULER_LOCK_NAME = "vroid:background:scheduler";

type ReservedSql = Awaited<ReturnType<typeof sql.reserve>>;

export type SchedulerOwner = {
  acquired: boolean;
  release: () => Promise<void>;
};

export async function startSchedulerIfOwner(): Promise<SchedulerOwner> {
  if (process.env.WORKER_SCHEDULER_ENABLED === "0") {
    console.log("[worker:scheduler] disabled by WORKER_SCHEDULER_ENABLED=0");
    return { acquired: false, release: async () => {} };
  }

  const reserved = await sql.reserve();
  const rows = await reserved<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtextextended(${SCHEDULER_LOCK_NAME}, 0)) AS acquired
  `;
  const acquired = rows[0]?.acquired === true;
  if (!acquired) {
    reserved.release();
    console.log("[worker:scheduler] standby: scheduler lock is held by another worker");
    return { acquired: false, release: async () => {} };
  }

  console.log("[worker:scheduler] acquired scheduler owner lock");
  startScheduler();

  return {
    acquired: true,
    release: async () => {
      await releaseSchedulerLock(reserved);
    },
  };
}

async function releaseSchedulerLock(reserved: ReservedSql): Promise<void> {
  try {
    await reserved`
      SELECT pg_advisory_unlock(hashtextextended(${SCHEDULER_LOCK_NAME}, 0))
    `;
  } catch (e) {
    console.warn("[worker:scheduler] failed to unlock scheduler advisory lock:", e);
  } finally {
    reserved.release();
    console.log("[worker:scheduler] released scheduler owner lock");
  }
}

// Keep the postgres import type reachable under isolatedModules.
void (null as unknown as postgres.Sql | null);
