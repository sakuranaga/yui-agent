/**
 * Centralized LLM (Anthropic) wrapper.
 *
 * 全ての messages.create はここを経由するように統一する。目的:
 *   - **モデル選択を 1 ファイルに集約** (role → model 解決、env override 可)
 *   - **リトライ** (overloaded/5xx を自動再試行、指数バックオフ)
 *   - **ログ + コスト計測** (各呼び出しを 1 行ログ、トレース単位で集計)
 *   - **将来の差し替え容易化** (6/15 の Agent SDK 移行時にここだけ触る)
 *
 * トレース (= 1 ユーザーターン / 1 periodic tick / 1 specialist job):
 *   `withTrace(name, async () => { ... })` で囲むと、その中で呼ばれた全 LLM の
 *   token / cost / 経過時間が集計され、トレース終了時に 1 行サマリを出す。
 *   AsyncLocalStorage 経由なので呼び出し側に context 伝播コードは不要。
 *
 * 用法:
 *   const res = await callLlm("judge", { system, messages, maxTokens: 200 });
 */
import Anthropic from "@anthropic-ai/sdk";
import { AsyncLocalStorage } from "node:async_hooks";
import { getAnthropicConfig } from "@/lib/ai-settings";
import { detectProvider } from "@/lib/llm-providers/detect";
import {
  getModel,
  getTierAssignment,
  getTierFallback,
  getRoleTierOverrides,
  type ModelEntry,
  type ModelProvider,
  type TierName,
} from "@/lib/model-registry";
import { callModelDirect } from "@/lib/model-call";

export type LlmRole =
  | "main"          // Yui Sonnet ターン
  | "voice"         // specialist 結果 → 結衣口調整形 (Haiku)
  | "judge"         // dispatch 必要性判定 (Haiku)
  | "report"        // ノートパネル markdown 整形 (Haiku)
  | "extract"       // raw_messages → memory_chunks 抽出 (Haiku)
  | "reconcile"    // chunk 重複/矛盾解消 (Haiku)
  | "news_curate"   // ニュースタイトル → 興味スコア (Haiku)
  | "news_speak"    // ニュース 1 件 → 結衣のセリフ (Sonnet)
  | "morning_speak" // 朝のブリーフ markdown → 結衣の挨拶セリフ (Haiku で十分)
  | "diary"         // 日記生成 (Sonnet)
  | "profile_synth" // ご主人様プロファイル スナップショット生成 (Sonnet 推奨、客観要約)
  | "sleep_intro"   // 睡眠サポート開始時の導入セリフ (Sonnet — 夜の最初の声に温度感)
  | "tts_normalize" // TTS 前処理 (記号 / 英語 / 漢字読み正規化、Haiku)
  | "mail_curate"   // メール仕分け (本文込み bucket + score、Haiku でも十分)
  | "food_extract"  // 会話から食事ログ抽出 (eaten_at 推定込み)、栄養 lookup の引き当ても兼ねる
  | "notify"        // MCP notify: 開発エージェントの進捗連絡 → 結衣口調に整形 (ローカル優先 + Haiku fallback)
  | "intent"        // cross-tool 変換 (artifact → 別ツールの下書き JSON、ローカル優先)
  | "project_suggest" // artifact → 関連プロジェクト提案 (ローカル優先)
  | "specialist";  // specialist 個別呼び出し (model は spec.model で上書き)

/** role → 3 tier (main/sub/heavy) の既定マップ (#206 §4)。
 *  role_tier_overrides で上書き可。挙動保存: 旧 SONNET_ROLES が main、残りが sub、specialist が heavy。 */
const DEFAULT_ROLE_TIER: Record<LlmRole, TierName> = {
  main: "main",
  news_speak: "main",
  diary: "main",
  sleep_intro: "main",
  profile_synth: "main",
  voice: "sub",
  judge: "sub",
  report: "sub",
  extract: "sub",
  reconcile: "sub",
  news_curate: "sub",
  morning_speak: "sub",
  mail_curate: "sub",
  tts_normalize: "sub",
  food_extract: "sub",
  notify: "sub",
  intent: "sub",
  project_suggest: "sub",
  specialist: "heavy",
};

export function resolveTier(role: LlmRole): TierName {
  return DEFAULT_ROLE_TIER[role] ?? "sub";
}

/** 既知の LlmRole 一覧 (role_tier_overrides の検証用)。 */
export const LLM_ROLES = Object.keys(DEFAULT_ROLE_TIER) as LlmRole[];
export function isLlmRole(s: string): s is LlmRole {
  return Object.prototype.hasOwnProperty.call(DEFAULT_ROLE_TIER, s);
}

/** registry に entry が無い時の防御用 ephemeral entry (model string 直指定 / 未 seed)。 */
function ephemeralEntry(modelId: string): ModelEntry {
  const provider = detectProvider(modelId) as ModelProvider;
  return {
    id: `ephemeral:${modelId}`,
    label: modelId,
    provider,
    modelId,
    baseUrl: null,
    apiKeyRef: provider === "local_openai" ? null : provider,
    capabilities: {},
    thinkingMode: "auto",
    maxTokens: 8192,
  };
}

async function entryForTier(tier: TierName): Promise<ModelEntry | null> {
  const assignment = await getTierAssignment();
  const id = assignment[tier];
  if (!id) return null;
  return getModel(id);
}

export type ResolvedEntry = { entry: ModelEntry; tier: TierName };

/**
 * role + override → 実際に呼ぶ entry と tier を解決 (#206 §8.5.2)。
 * 優先順位: override(entry id or raw model string) > role_tier_overrides > tier 割当 > 防御 ephemeral。
 */
export async function resolveEntry(role: LlmRole, override?: string): Promise<ResolvedEntry> {
  const tier = resolveTier(role);

  // 1. override (spec.model / opts.model) 最優先。entry id ならそれ、無ければ raw model string → ephemeral。
  if (override) {
    const byId = await getModel(override);
    return { entry: byId ?? ephemeralEntry(override), tier };
  }

  // 2. role_tier_overrides[role]: tier 名 or 実在 entry id のみ採用。不正値は warn して既定 tier へ。
  const overrides = await getRoleTierOverrides();
  const ov = overrides[role];
  if (ov) {
    if (ov === "main" || ov === "sub" || ov === "heavy") {
      const e = await entryForTier(ov);
      if (e) return { entry: e, tier: ov };
    } else {
      const byId = await getModel(ov);
      if (byId) return { entry: byId, tier };
      console.warn(
        `[llm:${role}] role_tier_overrides 値 "${ov}" は tier 名でも実在 entry でもない → 既定 tier (${tier}) に fallback`
      );
    }
  }

  // 3. 既定 tier 割当。
  const e = await entryForTier(tier);
  if (e) return { entry: e, tier };

  // 4. 防御: 割当未設定 / entry 消失 → 旧 anthropic 設定から ephemeral 合成。
  const cfg = await getAnthropicConfig();
  return { entry: ephemeralEntry(tier === "main" ? cfg.mainModel : cfg.haikuModel), tier };
}

/** モデル別単価 (USD per 1M tokens, 2026-04 時点)。
 * cache write = input × 1.25, cache read = input × 0.1 */
const PRICE: Record<string, { in: number; out: number }> = {
  "claude-opus-4-7":   { in: 5,  out: 25 },
  "claude-opus-4-6":   { in: 5,  out: 25 },
  "claude-sonnet-4-6": { in: 3,  out: 15 },
  "claude-sonnet-4-5": { in: 3,  out: 15 },
  "claude-haiku-4-5":  { in: 1,  out: 5  },
};

function estimateCostUsd(model: string, inT: number, outT: number, cacheR: number, cacheW: number): number {
  const p = PRICE[model] ?? { in: 3, out: 15 }; // 未知モデルは Sonnet 単価で安全寄り
  return (
    (inT * p.in +
      outT * p.out +
      cacheW * p.in * 1.25 +
      cacheR * p.in * 0.1) / 1_000_000
  );
}

// --- system log (= DB 永続化) ---
// 各 LLM 呼び出し / トレース完了を `llm_events` テーブルに append。
// LogModal の「システム」タブで期間指定 + 無限スクロール + clear する。
// fire-and-forget で書き込む (= ホットパスを止めない)。

export type LlmCallEvent = {
  type: "call";
  ts: number;
  role: LlmRole;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  durationMs: number;
  retries: number;
  traceId?: string;
};

export type LlmTraceEvent = {
  type: "trace";
  ts: number;
  traceId: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  llmMs: number;
  wallMs: number;
};

export type LlmEvent = LlmCallEvent | LlmTraceEvent;

import { appendLlmEvent } from "./llm-events-db";

function recordEvent(e: LlmEvent): void {
  // 非同期 (await しない)。書き込み失敗は warn だけ、ホットパスは止めない。
  void appendLlmEvent(e).catch((err) =>
    console.warn("[llm] log file append failed:", err)
  );
}

export type TraceUsage = {
  callCount: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  costUsd: number;
};

type TraceContext = { traceId: string; usage: TraceUsage };
const traceStore = new AsyncLocalStorage<TraceContext>();

function emptyUsage(): TraceUsage {
  return {
    callCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    costUsd: 0,
  };
}

/**
 * トレース内で全 LLM 呼び出しの token / cost / 時間を集計し、終了時に 1 行サマリを出す。
 *   await withTrace("chat:abc123", async () => { ... })
 * trace 内の各 callLlm のログには trace=abc123 が付く。
 */
export async function withTrace<T>(traceId: string, fn: () => Promise<T>): Promise<T> {
  const ctx: TraceContext = { traceId, usage: emptyUsage() };
  const t0 = Date.now();
  try {
    return await traceStore.run(ctx, fn);
  } finally {
    const wall = Date.now() - t0;
    const u = ctx.usage;
    if (u.callCount > 0) {
      console.log(
        `[llm:trace:${traceId}] calls=${u.callCount} in=${u.inputTokens} out=${u.outputTokens} cache_r=${u.cacheReadTokens} cache_w=${u.cacheWriteTokens} $${u.costUsd.toFixed(5)} llm_ms=${u.durationMs} wall_ms=${wall}`
      );
      recordEvent({
        type: "trace",
        ts: Date.now(),
        traceId,
        calls: u.callCount,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens,
        cacheWriteTokens: u.cacheWriteTokens,
        costUsd: u.costUsd,
        llmMs: u.durationMs,
        wallMs: wall,
      });
    }
  }
}

/** 現在のトレース usage (ない場合は null)。テスト/集計用 */
export function getTraceUsage(): TraceUsage | null {
  return traceStore.getStore()?.usage ?? null;
}

const MAX_RETRIES = 3;
const RETRYABLE_STATUSES = new Set([408, 429, 502, 503, 529]);

function isRetryable(e: unknown): boolean {
  const status = (e as { status?: number })?.status;
  return typeof status === "number" && RETRYABLE_STATUSES.has(status);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export type CallLlmOpts = {
  /** role default model を上書き。spec.model 等。 */
  model?: string;
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  maxTokens?: number;
  /** sampling temperature (未指定なら provider 既定)。 */
  temperature?: number;
  /** リトライ無効化したい場合 (例: 副作用テスト) */
  retry?: boolean;
};

/**
 * 1 つの entry で messages.create を実行 (retry + log + トレース集計込み)。
 * provider 別 dispatch は M2 の callModelDirect に委譲。失敗時は throw (= 呼側で tier fallback)。
 */
/**
 * entry.thinkingMode + tier から enableThinking を決める (#206 §8.9.3)。
 *   off → false (抑制) / on → true (強制) / auto → sub は false、main/heavy は undefined (サーバ既定)。
 * callModelDirect が local_openai 以外には渡さないので、ここでは provider を見ない。
 */
export function resolveEnableThinking(entry: ModelEntry, tier: TierName): boolean | undefined {
  if (entry.thinkingMode === "off") return false;
  if (entry.thinkingMode === "on") return true;
  return tier === "sub" ? false : undefined; // auto
}

async function attemptWithEntry(
  role: LlmRole,
  entry: ModelEntry,
  tier: TierName,
  opts: CallLlmOpts
): Promise<Anthropic.Message> {
  // maxTokens は既定化しない (undefined のまま callModelDirect に渡す)。未指定なら
  // callModelDirect が entry.maxTokens (per-model 上限、#206 §8.10) を使う。
  const retryEnabled = opts.retry !== false;
  const enableThinking = resolveEnableThinking(entry, tier);
  // local (= 自前ホスト) はコスト 0 で記録。PRICE 未知で Sonnet 単価に化けるのを防ぐ。
  const isLocal = entry.provider === "local_openai";

  let attempt = 0;
  let lastErr: unknown;

  while (attempt < (retryEnabled ? MAX_RETRIES : 1)) {
    // t0 は try ブロックの先頭で取り直す (= 成功時 durationMs に失敗試行 + backoff を混入させない)。
    const t0 = Date.now();
    try {
      const res = await callModelDirect(entry, {
        system: opts.system,
        messages: opts.messages,
        tools: opts.tools,
        maxTokens: opts.maxTokens,
        temperature: opts.temperature,
        enableThinking,
      });

      const dur = Date.now() - t0;
      const inT = res.usage.input_tokens ?? 0;
      const outT = res.usage.output_tokens ?? 0;
      const cacheR = res.usage.cache_read_input_tokens ?? 0;
      const cacheW = res.usage.cache_creation_input_tokens ?? 0;
      const cost = isLocal ? 0 : estimateCostUsd(entry.modelId, inT, outT, cacheR, cacheW);

      const trace = traceStore.getStore();
      if (trace) {
        trace.usage.callCount++;
        trace.usage.inputTokens += inT;
        trace.usage.outputTokens += outT;
        trace.usage.cacheReadTokens += cacheR;
        trace.usage.cacheWriteTokens += cacheW;
        trace.usage.durationMs += dur;
        trace.usage.costUsd += cost;
      }

      const tracePart = trace ? ` trace=${trace.traceId}` : "";
      const attemptPart = attempt > 0 ? ` retries=${attempt}` : "";
      // think= は local の thinking 制御 (#206 §8.9): false=抑制 / true=強制 / -=未送信(サーバ既定)
      const thinkPart = isLocal ? ` think=${enableThinking ?? "-"}` : "";
      console.log(
        `[llm:${role}] model=${entry.modelId} provider=${entry.provider} in=${inT} out=${outT} cache_r=${cacheR} cache_w=${cacheW} $${cost.toFixed(5)} ${dur}ms${thinkPart}${attemptPart}${tracePart}`
      );
      recordEvent({
        type: "call",
        ts: Date.now(),
        role,
        model: entry.modelId,
        inputTokens: inT,
        outputTokens: outT,
        cacheReadTokens: cacheR,
        cacheWriteTokens: cacheW,
        costUsd: cost,
        durationMs: dur,
        retries: attempt,
        traceId: trace?.traceId,
      });

      return res;
    } catch (e) {
      lastErr = e;
      if (retryEnabled && isRetryable(e) && attempt < MAX_RETRIES - 1) {
        const backoff = 500 * Math.pow(2, attempt); // 500, 1000, 2000ms
        console.warn(
          `[llm:${role}] retryable error (${(e as { status?: number })?.status}), retry in ${backoff}ms`
        );
        await sleep(backoff);
        attempt++;
        continue;
      }
      throw e;
    }
  }
  throw lastErr ?? new Error("callLlm: exhausted retries");
}

/**
 * LLM 呼び出しの統一エントリ (#206 M3)。
 * - **registry entry 解決** (role → tier → entry、override / role_tier_overrides 対応)
 * - provider 別 dispatch は callModelDirect (M2) に委譲
 * - **tier fallback**: primary が retry 尽きで失敗 → `model_tier_fallback[tier]` で 1 回再試行
 * - retry (overloaded/5xx 最大 3 回) + 1 行 log + トレース集計
 */
export async function callLlm(role: LlmRole, opts: CallLlmOpts): Promise<Anthropic.Message> {
  const { entry, tier } = await resolveEntry(role, opts.model);

  try {
    return await attemptWithEntry(role, entry, tier, opts);
  } catch (primaryErr) {
    // tier fallback: 別 entry が設定されていれば 1 回だけ切替再試行 (primary と同一なら skip)。
    const fallback = await getTierFallback();
    const fbId = fallback[tier];
    if (fbId && fbId !== entry.id) {
      const fbEntry = await getModel(fbId);
      if (fbEntry) {
        console.warn(
          `[llm:${role}] primary (${entry.modelId}) failed after retries, trying ${tier} fallback (${fbEntry.modelId}):`,
          primaryErr instanceof Error ? primaryErr.message : primaryErr
        );
        try {
          // fallback も同じ tier (resolveTier(role)) の性質で thinking 解決。
          return await attemptWithEntry(role, fbEntry, tier, opts);
        } catch (fbErr) {
          // fallback も失敗 → 設計 §8.5.4 通り primary の error を投げる (原因追跡用に fallback error は warn)。
          console.warn(
            `[llm:${role}] fallback (${fbEntry.modelId}) also failed:`,
            fbErr instanceof Error ? fbErr.message : fbErr
          );
          throw primaryErr;
        }
      }
    }
    console.error(`[llm:${role}] failed (no fallback available):`, primaryErr);
    throw primaryErr;
  }
}

