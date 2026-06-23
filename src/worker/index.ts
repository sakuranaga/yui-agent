import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "@/db/client";
import { startSchedulerIfOwner, type SchedulerOwner } from "@/worker/scheduler-owner";
import { startMaintenanceLoop, type MaintenanceOwner } from "@/worker/maintenance";
import { startSpecialistJobLoop } from "@/worker/specialist-jobs";
import { startConfirmExecutionLoop } from "@/worker/confirm-execution";
import { startBackgroundJobLoop } from "@/worker/background-jobs";
import { startRecoveryLoop } from "@/worker/recovery";

const ROLE = "background";
const HEARTBEAT_INTERVAL_MS = Number(process.env.WORKER_HEARTBEAT_INTERVAL_MS ?? 10_000);
const WORKER_ID =
  process.env.WORKER_ID ??
  `${ROLE}:${os.hostname()}:${process.pid}:${Date.now().toString(36)}`;

let shuttingDown = false;
let schedulerOwner: SchedulerOwner | null = null;
let maintenanceOwner: MaintenanceOwner | null = null;

function metadata(): Record<string, unknown> {
  return {
    nodeEnv: process.env.NODE_ENV ?? null,
    startedBy: "src/worker/index.ts",
    version: process.env.npm_package_version ?? null,
  };
}

async function writeHeartbeat(): Promise<void> {
  await sql`
    INSERT INTO worker_heartbeats (
      worker_id,
      role,
      hostname,
      pid,
      started_at,
      last_seen_at,
      metadata
    )
    VALUES (
      ${WORKER_ID},
      ${ROLE},
      ${os.hostname()},
      ${process.pid},
      NOW(),
      NOW(),
      ${JSON.stringify(metadata())}::jsonb
    )
    ON CONFLICT (worker_id) DO UPDATE SET
      role = EXCLUDED.role,
      hostname = EXCLUDED.hostname,
      pid = EXCLUDED.pid,
      last_seen_at = NOW(),
      metadata = EXCLUDED.metadata
  `;
}

async function heartbeatLoop(): Promise<void> {
  await writeHeartbeat();
  console.log(
    `[worker] started worker_id=${WORKER_ID} role=${ROLE} heartbeat=${HEARTBEAT_INTERVAL_MS}ms`
  );
  schedulerOwner = await startSchedulerIfOwner();
  maintenanceOwner = await startMaintenanceLoop({ shouldStop: () => shuttingDown });
  startSpecialistJobLoop({ shouldStop: () => shuttingDown });
  startConfirmExecutionLoop({ shouldStop: () => shuttingDown });
  startBackgroundJobLoop({ workerId: WORKER_ID, shouldStop: () => shuttingDown });
  startRecoveryLoop({ shouldStop: () => shuttingDown });

  while (!shuttingDown) {
    await sleep(HEARTBEAT_INTERVAL_MS);
    if (shuttingDown) break;
    try {
      await writeHeartbeat();
    } catch (e) {
      console.error("[worker] heartbeat failed:", e);
    }
  }
}

function requestShutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] received ${signal}; shutting down`);
}

process.on("SIGTERM", requestShutdown);
process.on("SIGINT", requestShutdown);

heartbeatLoop()
  .catch((e) => {
    console.error("[worker] fatal:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (schedulerOwner?.acquired) {
      await schedulerOwner.release();
    }
    if (maintenanceOwner?.acquired) {
      await maintenanceOwner.release();
    }
    try {
      await sql.end({ timeout: 5 });
    } catch (e) {
      console.warn("[worker] failed to close db connection:", e);
    }
    console.log("[worker] stopped");
  });
