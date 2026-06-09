/**
 * 記憶の自然減衰 (decay) 日次ジョブ。
 * 設計: docs/memory-architecture.md §16.7 Phase 5
 *
 * - 「未参照」= retrieval_log に直近 30 日のエントリなし
 *               AND created_at < 30 日前 (新しい chunk は守る)
 * - importance に応じた段階レート:
 *     ≥ 0.9 → 不変 (絶対忘れない)
 *     0.7 ≤ x < 0.9 → ×0.99 (緩やか)
 *     0.5 ≤ x < 0.7 → ×0.97 (中速)
 *     < 0.5 → ×0.95 (急速)
 * - reinforce_count ≥ 3 なら decay rate を半分 (1 - (1-rate)/2)
 * - importance < 0.05 になったら自動 invalidate
 * - 並行性: 1 chunk 1 transaction、per-row try/catch
 * - 集計を decay_runs に記録
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import { db, sql } from "@/db/client";
import { decayRuns } from "@/db/schema";
import { eq } from "drizzle-orm";

const UNREFERENCED_DAYS = 30;
const PROTECTED_THRESHOLD = 0.9;
const AUTO_INVALIDATE_THRESHOLD = 0.05;

function decayRateFor(importance: number): number {
  if (importance >= 0.9) return 1.0; // 不変
  if (importance >= 0.7) return 0.99;
  if (importance >= 0.5) return 0.97;
  return 0.95;
}

const memoryDecay: PeriodicModule = {
  id: "memory-decay",
  enabled: true,
  // 5 分間隔で判定、起動時刻 (JST 04:00 = UTC 19:00) を跨いだら 1 日 1 回だけ実行
  schedule: { kind: "interval", everyMs: 5 * 60_000 },
  run: async (_ctx: PeriodicContext): Promise<PeriodicResult> => {
    const now = new Date();
    const todayYmdJST = ymdJST(now);
    const hourJST = hourInJST(now);

    // 1 日 1 回 (04:00 JST 以降) のみ実行
    if (hourJST < 4) {
      return { skip: true, reason: `before 04:00 JST (now ${hourJST}h)` };
    }

    // 二重実行防止: tick が overlap した場合の二重 decay を防ぐ atomic claim。
    // 旧コードは「decay_runs SELECT → 比較 → 本処理 → INSERT」だったが race window
    // (= 2 tick が同時 SELECT して両方「未実行」と判定 → 両方が実行) があった。
    // INSERT ON CONFLICT DO NOTHING で 1 tick だけ row を取得できる仕組みに変更。
    const { claimJob } = await import("@/lib/job-claim");
    const claimed = await claimJob({
      key: `memory-decay:${todayYmdJST}`,
      moduleId: "memory-decay",
    });
    if (!claimed) {
      return { skip: true, reason: `already claimed today (${todayYmdJST})` };
    }

    const startMs = Date.now();
    const unrefCutoff = new Date(now.getTime() - UNREFERENCED_DAYS * 86_400_000);

    // 「未参照かつ古い」chunk を取得 (有効、importance < 0.9 = protected 除外)
    // last retrieval の判定: retrieval_log の chunk_id 別 MAX(retrieved_at)
    type DecayCandidate = {
      id: number;
      importance: number;
      reinforce_count: number;
    };
    const candidates = await sql<DecayCandidate[]>`
      WITH last_ret AS (
        SELECT chunk_id, MAX(retrieved_at) AS last_at
        FROM retrieval_log
        GROUP BY chunk_id
      )
      SELECT
        c.id,
        c.importance,
        COALESCE((c.metadata->>'reinforce_count')::int, 0) AS reinforce_count
      FROM memory_chunks c
      LEFT JOIN last_ret r ON c.id = r.chunk_id
      WHERE c.invalidated_at IS NULL
        AND c.importance < ${PROTECTED_THRESHOLD}
        AND c.created_at < ${unrefCutoff.toISOString()}::timestamptz
        AND (r.last_at IS NULL OR r.last_at < ${unrefCutoff.toISOString()}::timestamptz)
    `;

    let processed = 0;
    let decayed = 0;
    let invalidated = 0;
    let errors = 0;
    // importance バケット (decay 観察用)。high (≥0.7) は元実装で抜けていたため
    // ≥0.7 と ≥0.5 が両方 mid に流れていた (= histogram で重要度上位が見えなかった)。
    const histogram = { protected: 0, high: 0, mid: 0, low: 0, autoInvalidated: 0 };

    for (const c of candidates) {
      processed++;
      try {
        let rate = decayRateFor(c.importance);
        if (rate >= 1.0) {
          histogram.protected++;
          continue;
        }
        // reinforce_count ≥ 3 なら decay rate を半分 (= 減衰量を半分)
        if (c.reinforce_count >= 3) {
          rate = 1 - (1 - rate) / 2;
        }
        const newImportance = c.importance * rate;
        if (newImportance < AUTO_INVALIDATE_THRESHOLD) {
          // auto invalidate (記録に reason 付与)
          await sql`
            UPDATE memory_chunks
            SET invalidated_at = NOW(),
                metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                    'invalidation_reason', 'auto_decay_below_threshold',
                    'last_importance_before_invalidate', ${c.importance}
                  )
            WHERE id = ${c.id} AND invalidated_at IS NULL
          `;
          invalidated++;
          histogram.autoInvalidated++;
        } else {
          await sql`
            UPDATE memory_chunks
            SET importance = ${newImportance},
                metadata = COALESCE(metadata, '{}'::jsonb)
                  || jsonb_build_object(
                    'last_decay_at', NOW()::text,
                    'decay_count', COALESCE((metadata->>'decay_count')::int, 0) + 1
                  )
            WHERE id = ${c.id} AND invalidated_at IS NULL
          `;
          decayed++;
          if (c.importance >= 0.7) histogram.high++;
          else if (c.importance >= 0.5) histogram.mid++;
          else histogram.low++;
        }
      } catch (e) {
        errors++;
        console.warn(`[memory-decay] chunk ${c.id} failed:`, e);
      }
    }

    const durationMs = Date.now() - startMs;
    try {
      await db.insert(decayRuns).values({
        processed,
        decayed,
        invalidated,
        errors,
        durationMs,
        details: { histogram, candidatesCount: candidates.length },
      });
    } catch (e) {
      console.warn("[memory-decay] decay_runs insert failed:", e);
    }
    console.log(
      `[memory-decay] processed=${processed} decayed=${decayed} invalidated=${invalidated} errors=${errors} duration=${durationMs}ms`
    );
    return {
      skip: true,
      reason: `decay run completed: processed=${processed}, decayed=${decayed}, invalidated=${invalidated}`,
    };
  },
};

function ymdJST(d: Date): string {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function hourInJST(d: Date): number {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
  });
  return parseInt(fmt.formatToParts(d).find((p) => p.type === "hour")?.value ?? "0", 10);
}

// eslint warning silencer
void eq;

export default memoryDecay;
