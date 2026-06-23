import { setTimeout as sleep } from "node:timers/promises";
import { sql } from "@/db/client";
import { processStaleSessions } from "@/lib/extract";
import { pruneExpiredAttachments } from "@/lib/chat-attachments";
import { pruneOldNews } from "@/lib/news";
import { loadLocationFromDb } from "@/lib/location";
import { migrateOAuthTokensToEncrypted } from "@/lib/oauth-token-migrate";
import { seedTtsDictionaryIfEmpty } from "@/lib/tts-dictionary";
import { rearmAllPending } from "@/lib/timers";

const MAINTENANCE_LOCK_NAME = "vroid:background:maintenance";
const MAINTENANCE_INTERVAL_MS = Number(process.env.WORKER_MAINTENANCE_INTERVAL_MS ?? 5 * 60 * 1000);

type ReservedSql = Awaited<ReturnType<typeof sql.reserve>>;

export type MaintenanceOwner = {
  acquired: boolean;
  release: () => Promise<void>;
};

export async function startMaintenanceLoop(args: {
  shouldStop: () => boolean;
}): Promise<MaintenanceOwner> {
  if (process.env.WORKER_MAINTENANCE_ENABLED === "0") {
    console.log("[worker:maintenance] disabled by WORKER_MAINTENANCE_ENABLED=0");
    return { acquired: false, release: async () => {} };
  }

  const reserved = await sql.reserve();
  const rows = await reserved<{ acquired: boolean }[]>`
    SELECT pg_try_advisory_lock(hashtextextended(${MAINTENANCE_LOCK_NAME}, 0)) AS acquired
  `;
  const acquired = rows[0]?.acquired === true;
  if (!acquired) {
    reserved.release();
    console.log("[worker:maintenance] standby: maintenance lock is held by another worker");
    return { acquired: false, release: async () => {} };
  }

  console.log("[worker:maintenance] acquired maintenance owner lock");
  void maintenanceLoop(args.shouldStop).catch((e) =>
    console.error("[worker:maintenance] loop failed:", e),
  );

  return {
    acquired: true,
    release: async () => {
      await releaseMaintenanceLock(reserved);
    },
  };
}

async function maintenanceLoop(shouldStop: () => boolean): Promise<void> {
  await runBootMaintenance();
  await runPeriodicMaintenance();

  while (!shouldStop()) {
    await sleep(MAINTENANCE_INTERVAL_MS);
    if (shouldStop()) break;
    await runPeriodicMaintenance();
  }
}

async function runBootMaintenance(): Promise<void> {
  console.log("[worker:maintenance] running boot maintenance");

  try {
    await loadLocationFromDb();
  } catch (e) {
    console.warn("[worker:maintenance] loadLocationFromDb failed:", e);
  }

  try {
    const n = await rearmAllPending();
    if (n > 0) console.log(`[worker:maintenance] re-armed ${n} pending timer(s)`);
  } catch (e) {
    console.warn("[worker:maintenance] rearmAllPending failed:", e);
  }

  try {
    await migrateOAuthTokensToEncrypted();
  } catch (e) {
    console.warn("[worker:maintenance] migrateOAuthTokensToEncrypted failed:", e);
  }

  try {
    const r = await seedTtsDictionaryIfEmpty();
    if (r.seeded > 0) {
      console.log(`[worker:maintenance] tts_dictionary seeded ${r.seeded} preset entries`);
    }
  } catch (e) {
    console.warn("[worker:maintenance] seedTtsDictionaryIfEmpty failed:", e);
  }

  try {
    const { seedModelRegistryIfEmpty, migrateLocalRolesToTierOverrides, migrateIntentRolesToLocal } =
      await import("@/lib/model-registry");
    const r = await seedModelRegistryIfEmpty();
    if (r.seeded > 0) {
      console.log(`[worker:maintenance] model_registry seeded ${r.seeded} entries`);
    }
    const m = await migrateLocalRolesToTierOverrides();
    if (m.migrated) {
      console.log(`[worker:maintenance] local roles migrated (${m.roles} roles)`);
    }
    const mi = await migrateIntentRolesToLocal();
    if (mi.migrated) {
      console.log(`[worker:maintenance] intent/project_suggest migrated (${mi.roles} roles)`);
    }
  } catch (e) {
    console.warn("[worker:maintenance] model registry migration failed:", e);
  }

  try {
    const { releaseStuckProcessing, kickFillWorker } = await import("@/lib/food-nutrition-worker");
    await releaseStuckProcessing();
    void kickFillWorker();
  } catch (e) {
    console.warn("[worker:maintenance] food nutrition worker kick failed:", e);
  }
}

async function runPeriodicMaintenance(): Promise<void> {
  try {
    const n = await processStaleSessions();
    if (n > 0) {
      console.log(`[worker:maintenance] stale sessions processed: ${n}`);
    }
  } catch (e) {
    console.warn("[worker:maintenance] processStaleSessions failed:", e);
  }

  try {
    const r = await pruneExpiredAttachments();
    if (r.deletedFiles > 0) {
      console.log(
        `[worker:maintenance] pruned chat attachments: ${r.deletedFiles} files / ${r.prunedRows} rows`,
      );
    }
  } catch (e) {
    console.warn("[worker:maintenance] pruneExpiredAttachments failed:", e);
  }

  try {
    const r = await pruneOldNews();
    if (r.deleted > 0) {
      console.log(`[worker:maintenance] pruned old news articles: ${r.deleted} rows`);
    }
  } catch (e) {
    console.warn("[worker:maintenance] pruneOldNews failed:", e);
  }

  try {
    const { kickFillWorker } = await import("@/lib/food-nutrition-worker");
    void kickFillWorker();
  } catch (e) {
    console.warn("[worker:maintenance] food nutrition worker kick failed:", e);
  }
}

async function releaseMaintenanceLock(reserved: ReservedSql): Promise<void> {
  try {
    await reserved`
      SELECT pg_advisory_unlock(hashtextextended(${MAINTENANCE_LOCK_NAME}, 0))
    `;
  } catch (e) {
    console.warn("[worker:maintenance] failed to unlock maintenance advisory lock:", e);
  } finally {
    reserved.release();
    console.log("[worker:maintenance] released maintenance owner lock");
  }
}
