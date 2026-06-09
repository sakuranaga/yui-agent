/**
 * LLM イベントの永続ログ。
 *
 * 各 LLM call / trace 完了時に llm_events テーブルに 1 row append。
 * お給料 (cost_usd 累計 in JPY) や 月次集計を SQL で行うため、
 * 設定 > データ タブの統計表示は全てここから読む。
 */
import { and, desc, gte, lt, lte, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { llmEvents } from "@/db/schema";
import { broadcastStatsUpdate } from "@/lib/jobs/events";
import type { LlmEvent } from "./llm";

/** 1 イベントを記録 (call / trace 共通)。fire-and-forget で呼ばれる想定。 */
export async function appendLlmEvent(e: LlmEvent): Promise<void> {
  if (e.type === "call") {
    await db.insert(llmEvents).values({
      eventType: "call",
      ts: e.ts,
      role: e.role,
      model: e.model,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheWriteTokens: e.cacheWriteTokens,
      costUsd: e.costUsd,
      durationMs: e.durationMs,
      retries: e.retries,
      traceId: e.traceId ?? null,
    });
    // call 行のみ給料 (= cost 累計) を変化させるので broadcast。trace は集計重複なので skip。
    broadcastStatsUpdate();
  } else {
    await db.insert(llmEvents).values({
      eventType: "trace",
      ts: e.ts,
      traceId: e.traceId,
      calls: e.calls,
      inputTokens: e.inputTokens,
      outputTokens: e.outputTokens,
      cacheReadTokens: e.cacheReadTokens,
      cacheWriteTokens: e.cacheWriteTokens,
      costUsd: e.costUsd,
      llmMs: e.llmMs,
      wallMs: e.wallMs,
    });
  }
}

export type ReadLogOpts = {
  /** これより古いイベントのみ返す (前ページの最古 ts を渡す) */
  beforeTs?: number;
  /** 期間下限 (これより新しい) */
  fromTs?: number;
  /** 期間上限 (これより古い) */
  toTs?: number;
  /** 返す件数上限 (デフォルト 50) */
  limit?: number;
};

/** 新しい順に最大 limit 件返す。row → LlmEvent 変換は呼び出し側にとって透過。 */
export async function readLlmEvents(opts: ReadLogOpts = {}): Promise<LlmEvent[]> {
  const limit = opts.limit ?? 50;
  const conds = [];
  if (opts.beforeTs !== undefined) conds.push(lt(llmEvents.ts, opts.beforeTs));
  if (opts.fromTs !== undefined) conds.push(gte(llmEvents.ts, opts.fromTs));
  if (opts.toTs !== undefined) conds.push(lte(llmEvents.ts, opts.toTs));
  const where = conds.length > 0 ? and(...conds) : undefined;
  const rows = await db
    .select()
    .from(llmEvents)
    .where(where)
    .orderBy(desc(llmEvents.ts))
    .limit(limit);
  return rows.map((r) => {
    if (r.eventType === "call") {
      return {
        type: "call",
        ts: Number(r.ts),
        role: r.role as LlmEvent extends { type: "call"; role: infer R } ? R : string,
        model: r.model ?? "",
        inputTokens: r.inputTokens ?? 0,
        outputTokens: r.outputTokens ?? 0,
        cacheReadTokens: r.cacheReadTokens ?? 0,
        cacheWriteTokens: r.cacheWriteTokens ?? 0,
        costUsd: r.costUsd ?? 0,
        durationMs: r.durationMs ?? 0,
        retries: r.retries ?? 0,
        traceId: r.traceId ?? undefined,
      } as LlmEvent;
    }
    return {
      type: "trace",
      ts: Number(r.ts),
      traceId: r.traceId ?? "",
      calls: r.calls ?? 0,
      inputTokens: r.inputTokens ?? 0,
      outputTokens: r.outputTokens ?? 0,
      cacheReadTokens: r.cacheReadTokens ?? 0,
      cacheWriteTokens: r.cacheWriteTokens ?? 0,
      costUsd: r.costUsd ?? 0,
      llmMs: r.llmMs ?? 0,
      wallMs: r.wallMs ?? 0,
    } as LlmEvent;
  });
}

/** 行数 (UI で「○件」表示に使う、旧 sizeBytes の代替) */
export async function getLogTotalCount(): Promise<number> {
  const rows = await db
    .select({ c: sql<number>`count(*)::int` })
    .from(llmEvents);
  return rows[0]?.c ?? 0;
}

/** 全削除 (LogModal の clear ボタンから) */
export async function clearLogs(): Promise<void> {
  await db.delete(llmEvents);
}

/**
 * 期間内の cost_usd 合算 (call 行のみ。trace は同じターンの集計なので
 * call と二重計上を避ける)。fromTs 省略時は全期間。
 */
export async function sumCostUsd(opts: { fromTs?: number; toTs?: number } = {}): Promise<number> {
  const conds = [sql`${llmEvents.eventType} = 'call'`];
  if (opts.fromTs !== undefined) conds.push(gte(llmEvents.ts, opts.fromTs));
  if (opts.toTs !== undefined) conds.push(lt(llmEvents.ts, opts.toTs));
  const rows = await db
    .select({ s: sql<number>`coalesce(sum(${llmEvents.costUsd}), 0)::real` })
    .from(llmEvents)
    .where(and(...conds));
  return Number(rows[0]?.s ?? 0);
}
