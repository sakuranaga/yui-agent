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
import { getAiSetting, getAnthropicConfig, shouldUseLocalLlmFor } from "@/lib/ai-settings";
import { callLocalLlm } from "@/lib/local-llm";
import { detectProvider } from "@/lib/llm-providers/detect";
import { callOpenAICompat } from "@/lib/llm-providers/openai";
import { callGemini } from "@/lib/llm-providers/gemini";
import type { ProviderId } from "@/lib/llm-models";

// Anthropic client は call ごとに最新 apiKey で構築。設定 UI からの変更を
// 30s キャッシュ越しに自動反映する。client インスタンス自体は軽い (config だけ)。
async function getClient(): Promise<Anthropic> {
  const cfg = await getAnthropicConfig();
  return new Anthropic({ apiKey: cfg.apiKey ?? undefined });
}

/** provider 別に API キーを引く */
async function getProviderApiKey(provider: ProviderId): Promise<string | null> {
  switch (provider) {
    case "anthropic": return getAiSetting("anthropic_api_key");
    case "openai":    return getAiSetting("openai_api_key");
    case "gemini":    return getAiSetting("gemini_api_key");
    case "grok":      return getAiSetting("grok_api_key");
  }
}

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
  | "specialist";  // specialist 個別呼び出し (model は spec.model で上書き)

/** role 全部を main / haiku の 2 モデルにマップする。AI 設定 UI で 2 つだけ
 * 公開する設計上、role 別 env override は廃止。override 引数 (spec.model) は
 * specialist 用に残す。 */
const SONNET_ROLES = new Set<LlmRole>(["main", "news_speak", "diary", "sleep_intro", "profile_synth"]);

async function resolveModel(role: LlmRole, override?: string): Promise<string> {
  if (override) return override;
  const cfg = await getAnthropicConfig();
  return SONNET_ROLES.has(role) ? cfg.mainModel : cfg.haikuModel;
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
  /** リトライ無効化したい場合 (例: 副作用テスト) */
  retry?: boolean;
};

/**
 * Anthropic messages.create の薄いラッパー。
 * - モデル解決 (role + override)
 * - リトライ (overloaded/5xx を最大 3 回)
 * - 1 行 log + トレース集計
 */
export async function callLlm(role: LlmRole, opts: CallLlmOpts): Promise<Anthropic.Message> {
  // ローカル LLM (Gemma 等) を使うべき role かチェック。
  // tool 利用 / system が配列 (TextBlockParam[]) の高度な構造は Anthropic 専用なので
  // そのケースは強制的に Anthropic 経路に倒す (ローカルは text-only 想定)。
  const hasComplexSystem = Array.isArray(opts.system);
  const hasTools = !!opts.tools && opts.tools.length > 0;
  const isMessageContentSimple = opts.messages.every(
    (m) => typeof m.content === "string"
  );
  if (
    !hasComplexSystem &&
    !hasTools &&
    isMessageContentSimple &&
    (await shouldUseLocalLlmFor(role))
  ) {
    // ローカル設定済 + role が対象 = ここに入る。未設定の人はそもそも入らないので
    // 「未設定の人が毎回エラー → fallback」にはならない。
    // callLocalLlm 内部で MAX_RETRIES まで自前 retry してから throw するので、
    // 一過性のネット blip では fallback しない (= 鯖が本当に死んでる時のみ)。
    try {
      const localRes = await callLocalLlm({
        system: typeof opts.system === "string" ? opts.system : undefined,
        messages: opts.messages as Array<{ role: "user" | "assistant"; content: string }>,
        maxTokens: opts.maxTokens,
        roleLabel: role,
      });
      // trace usage 集計 (cost 0 / cache 0)
      const trace = traceStore.getStore();
      if (trace) {
        trace.usage.callCount++;
        trace.usage.inputTokens += localRes.usage.input_tokens;
        trace.usage.outputTokens += localRes.usage.output_tokens;
      }
      recordEvent({
        type: "call",
        ts: Date.now(),
        role,
        model: localRes.model ?? "local",
        inputTokens: localRes.usage.input_tokens,
        outputTokens: localRes.usage.output_tokens,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0,
        durationMs: 0,
        retries: 0,
        traceId: trace?.traceId,
      });
      return localRes;
    } catch (e) {
      // ローカル鯖死亡 → hosted (= 該当 role の sub model、SONNET_ROLES でなければ Haiku) に fall-through。
      // 警告は 1 回出す (= slient コスト上昇を見落とさないため)。設定 → 通知 や監視で拾うのは将来課題。
      console.warn(
        `[llm:${role}] local LLM failed, falling back to hosted:`,
        e instanceof Error ? e.message : e
      );
      // 下の hosted path に fall-through
    }
  }

  const model = await resolveModel(role, opts.model);
  const provider = detectProvider(model);
  const maxTokens = opts.maxTokens ?? 1024;
  const retryEnabled = opts.retry !== false;

  let attempt = 0;
  let lastErr: unknown;

  while (attempt < (retryEnabled ? MAX_RETRIES : 1)) {
    // t0 は try ブロックの先頭で取り直す (= 成功時の durationMs に
    // 直前の失敗試行 + backoff sleep が混入しないように)。retry loop の外で 1 回だけ
    // 取ると、retry 後に成功した時 dur が backoff 待機込みになりトレース指標が腫れる。
    const t0 = Date.now();
    try {
      let res: Anthropic.Message;
      if (provider === "anthropic") {
        const client = await getClient();
        res = await client.messages.create({
          model,
          max_tokens: maxTokens,
          ...(opts.system !== undefined ? { system: opts.system } : {}),
          messages: opts.messages,
          ...(opts.tools && opts.tools.length > 0 ? { tools: opts.tools } : {}),
        });
      } else {
        const apiKey = await getProviderApiKey(provider);
        if (!apiKey) {
          throw new Error(`${provider} API key 未設定 (model=${model})`);
        }
        if (provider === "openai" || provider === "grok") {
          res = await callOpenAICompat({
            apiKey,
            baseUrl: provider === "grok" ? "https://api.x.ai/v1" : "https://api.openai.com/v1",
            model,
            maxTokens,
            // OpenAI 新モデル (GPT-5 / o-series) は max_completion_tokens 必須。
            // Grok は OpenAI 互換 API だが max_tokens を受け付ける。
            tokenParamName: provider === "openai" ? "max_completion_tokens" : "max_tokens",
            system: opts.system,
            messages: opts.messages,
            tools: opts.tools,
          });
        } else {
          // gemini
          res = await callGemini({
            apiKey,
            model,
            maxTokens,
            system: opts.system,
            messages: opts.messages,
            tools: opts.tools,
          });
        }
      }
      const dur = Date.now() - t0;
      const inT = res.usage.input_tokens ?? 0;
      const outT = res.usage.output_tokens ?? 0;
      const cacheR = res.usage.cache_read_input_tokens ?? 0;
      const cacheW = res.usage.cache_creation_input_tokens ?? 0;
      const cost = estimateCostUsd(model, inT, outT, cacheR, cacheW);

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
      console.log(
        `[llm:${role}] model=${model} in=${inT} out=${outT} cache_r=${cacheR} cache_w=${cacheW} $${cost.toFixed(5)} ${dur}ms${attemptPart}${tracePart}`
      );
      recordEvent({
        type: "call",
        ts: Date.now(),
        role,
        model,
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
      // non-retryable / 最終失敗
      console.error(`[llm:${role}] failed after ${attempt + 1} attempt(s):`, e);
      throw e;
    }
  }
  throw lastErr ?? new Error("callLlm: exhausted retries");
}

