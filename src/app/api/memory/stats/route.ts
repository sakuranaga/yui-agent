/**
 * GET /api/memory/stats
 *   記憶層の運用統計。MemorySection の統計パネル / 監視ダッシュボード用。
 *
 * 設計: docs/memory-architecture.md §16.7 Phase 8
 */
import { NextResponse, type NextRequest } from "next/server";
import { sql } from "@/db/client";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    // 1) 総数 / valid / invalidated
    const totals = await sql<[{ total: string; valid: string; invalidated: string }]>`
      SELECT
        COUNT(*)::text AS total,
        COUNT(*) FILTER (WHERE invalidated_at IS NULL)::text AS valid,
        COUNT(*) FILTER (WHERE invalidated_at IS NOT NULL)::text AS invalidated
      FROM memory_chunks
    `;

    // 2) type 別
    const byType = await sql<Array<{ chunk_type: string; n: string }>>`
      SELECT chunk_type, COUNT(*)::text AS n
      FROM memory_chunks
      WHERE invalidated_at IS NULL
      GROUP BY chunk_type
      ORDER BY n DESC
    `;

    // 3) owner 別
    const byOwner = await sql<Array<{ owner: string; n: string }>>`
      SELECT owner, COUNT(*)::text AS n
      FROM memory_chunks
      WHERE invalidated_at IS NULL
      GROUP BY owner
    `;

    // 4) importance バンド
    const bands = await sql<
      [{ high: string; mid_hi: string; mid: string; low: string }]
    >`
      SELECT
        COUNT(*) FILTER (WHERE importance >= 0.9)::text AS high,
        COUNT(*) FILTER (WHERE importance >= 0.7 AND importance < 0.9)::text AS mid_hi,
        COUNT(*) FILTER (WHERE importance >= 0.5 AND importance < 0.7)::text AS mid,
        COUNT(*) FILTER (WHERE importance < 0.5)::text AS low
      FROM memory_chunks
      WHERE invalidated_at IS NULL
    `;

    // 5) decay 直近
    const lastDecay = await sql<
      [{ ran_at: Date | string | null; decayed: number; invalidated: number }] | []
    >`
      SELECT ran_at, decayed, invalidated
      FROM decay_runs
      ORDER BY ran_at DESC
      LIMIT 1
    `;

    const last7d = new Date(Date.now() - 7 * 86_400_000);
    const decay7d = await sql<[{ decayed: string; invalidated: string }]>`
      SELECT
        COALESCE(SUM(decayed), 0)::text AS decayed,
        COALESCE(SUM(invalidated), 0)::text AS invalidated
      FROM decay_runs
      WHERE ran_at > ${last7d.toISOString()}::timestamptz
    `;

    // 6) top reinforced
    const topReinforced = await sql<
      Array<{
        id: number;
        content: string;
        importance: number;
        owner: string;
        reinforce_count: number;
      }>
    >`
      SELECT id, content, importance, owner,
             COALESCE((metadata->>'reinforce_count')::int, 0) AS reinforce_count
      FROM memory_chunks
      WHERE invalidated_at IS NULL
        AND COALESCE((metadata->>'reinforce_count')::int, 0) > 0
      ORDER BY reinforce_count DESC, importance DESC
      LIMIT 10
    `;

    // 7) retrieval 活動 (直近 7 日)
    const retActivity = await sql<
      [{ total: string; unique_chunks: string }]
    >`
      SELECT
        COUNT(*)::text AS total,
        COUNT(DISTINCT chunk_id)::text AS unique_chunks
      FROM retrieval_log
      WHERE retrieved_at > ${last7d.toISOString()}::timestamptz
    `;

    // ran_at は postgres-js から Date / string 両方で来うるので両対応
    const toIso = (v: Date | string | null | undefined): string | null => {
      if (!v) return null;
      if (typeof v === "string") return v;
      try {
        return v.toISOString();
      } catch {
        return null;
      }
    };

    return NextResponse.json({
      total: parseInt(totals[0].total, 10),
      valid: parseInt(totals[0].valid, 10),
      invalidated: parseInt(totals[0].invalidated, 10),
      byType: Object.fromEntries(byType.map((r) => [r.chunk_type, parseInt(r.n, 10)])),
      byOwner: Object.fromEntries(byOwner.map((r) => [r.owner, parseInt(r.n, 10)])),
      importanceBands: {
        "0.9+": parseInt(bands[0].high, 10),
        "0.7+": parseInt(bands[0].mid_hi, 10),
        "0.5+": parseInt(bands[0].mid, 10),
        "<0.5": parseInt(bands[0].low, 10),
      },
      decay: {
        lastRunAt: lastDecay.length > 0 ? toIso(lastDecay[0].ran_at) : null,
        lastRunDecayed: lastDecay.length > 0 ? lastDecay[0].decayed : 0,
        lastRunInvalidated: lastDecay.length > 0 ? lastDecay[0].invalidated : 0,
        decayedLast7d: parseInt(decay7d[0].decayed, 10),
        invalidatedLast7d: parseInt(decay7d[0].invalidated, 10),
      },
      topReinforced: topReinforced.map((r) => ({
        id: Number(r.id),
        content: r.content,
        importance: r.importance,
        owner: r.owner,
        reinforceCount: r.reinforce_count,
      })),
      retrievalActivity: {
        totalLast7d: parseInt(retActivity[0].total, 10),
        uniqueChunksLast7d: parseInt(retActivity[0].unique_chunks, 10),
      },
    });
  } catch (e) {
    return clientError(req, e, { context: "memory/stats", message: "記憶層統計の取得に失敗しました" });
  }
}
