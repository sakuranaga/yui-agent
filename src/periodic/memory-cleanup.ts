/**
 * 記憶層の定期 cleanup ジョブ。週次 (日曜 03:00 JST)。
 * 設計: docs/memory-architecture.md §16.7 Phase 7
 *
 * - retrieval_log: 1 年経過 row を物理削除 (永続的に膨らむため)
 * - memory_chunks: invalidated_at + 180 日経過の行を物理削除
 *   (FK CASCADE で関連 retrieval_log も自動削除される)
 * - decay_runs: 3 ヶ月以上前の集計を削除 (短期傾向だけ残せば十分)
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import { sql } from "@/db/client";

const RETRIEVAL_LOG_RETENTION_DAYS = 365;
const INVALIDATED_CHUNK_RETENTION_DAYS = 180;
const DECAY_RUNS_RETENTION_DAYS = 90;

const memoryCleanup: PeriodicModule = {
  id: "memory-cleanup",
  enabled: true,
  schedule: { kind: "interval", everyMs: 60 * 60_000 }, // 1 時間ごとに判定、週次条件で発火
  run: async (_ctx: PeriodicContext): Promise<PeriodicResult> => {
    const now = new Date();
    const dowJST = dayOfWeekJST(now); // 0 = 日曜
    const hourJST = hourInJST(now);

    // 日曜 (dow=0) かつ 03 時以降。旧実装は 03:00-03:59 JST の 1 時間枠のみで、
    // この窓でプロセスが落ちていると週次クリーンアップが丸々スキップされていた。
    // 「日曜なら 03 時以降のどこかで 1 回」に広げ、二重実行は下の claimJob で抑える。
    if (dowJST !== 0 || hourJST < 3) {
      return { skip: true, reason: `not weekly window (dow=${dowJST}, hour=${hourJST}h JST)` };
    }

    // atomic claim: 同一 DB を 2 process 共有しても 1 process だけが本処理する。
    // key は日曜日の JST YMD (= 各週で一意) を使う。
    const sundayYmd = ymdJST(now);
    const { claimJob } = await import("@/lib/job-claim");
    const claimed = await claimJob({
      key: `memory-cleanup:${sundayYmd}`,
      moduleId: "memory-cleanup",
    });
    if (!claimed) {
      return { skip: true, reason: `already claimed this week (${sundayYmd})` };
    }

    const startMs = Date.now();
    const cutoffRetLog = new Date(now.getTime() - RETRIEVAL_LOG_RETENTION_DAYS * 86_400_000);
    const cutoffChunks = new Date(now.getTime() - INVALIDATED_CHUNK_RETENTION_DAYS * 86_400_000);
    const cutoffDecayRuns = new Date(now.getTime() - DECAY_RUNS_RETENTION_DAYS * 86_400_000);

    let retLogDeleted = 0;
    let chunksDeleted = 0;
    let decayRunsDeleted = 0;

    try {
      const r1 = await sql<[{ count: string }]>`
        WITH deleted AS (
          DELETE FROM retrieval_log
          WHERE retrieved_at < ${cutoffRetLog.toISOString()}::timestamptz
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `;
      retLogDeleted = parseInt(r1[0].count, 10);
    } catch (e) {
      console.warn("[memory-cleanup] retrieval_log delete failed:", e);
    }

    try {
      // chunks 削除時、FK CASCADE で残存 retrieval_log も連動削除される
      const r2 = await sql<[{ count: string }]>`
        WITH deleted AS (
          DELETE FROM memory_chunks
          WHERE invalidated_at IS NOT NULL
            AND invalidated_at < ${cutoffChunks.toISOString()}::timestamptz
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `;
      chunksDeleted = parseInt(r2[0].count, 10);
    } catch (e) {
      console.warn("[memory-cleanup] memory_chunks delete failed:", e);
    }

    try {
      const r3 = await sql<[{ count: string }]>`
        WITH deleted AS (
          DELETE FROM decay_runs
          WHERE ran_at < ${cutoffDecayRuns.toISOString()}::timestamptz
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM deleted
      `;
      decayRunsDeleted = parseInt(r3[0].count, 10);
    } catch (e) {
      console.warn("[memory-cleanup] decay_runs delete failed:", e);
    }

    const durationMs = Date.now() - startMs;
    console.log(
      `[memory-cleanup] retrieval_log=${retLogDeleted}, chunks=${chunksDeleted}, decay_runs=${decayRunsDeleted}, duration=${durationMs}ms`
    );
    return {
      skip: true,
      reason: `cleanup: ret_log=${retLogDeleted}, chunks=${chunksDeleted}, decay=${decayRunsDeleted}`,
    };
  },
};

function dayOfWeekJST(d: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Tokyo", weekday: "short" });
  const w = fmt.formatToParts(d).find((p) => p.type === "weekday")?.value ?? "Sun";
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return map[w] ?? 0;
}

function hourInJST(d: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
  });
  return parseInt(fmt.formatToParts(d).find((p) => p.type === "hour")?.value ?? "0", 10);
}

function ymdJST(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export default memoryCleanup;
