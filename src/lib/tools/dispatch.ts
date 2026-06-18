/**
 * dispatchTool — 全 tool use の単一ゲートウェイ (docs/tool-dispatch-redesign.md §5.5)。
 *
 * 既存の runTool (権限/confirm/untrusted ラップ/handler) を包み、横断的関心事を集約する:
 *   - dispatch メタ解決 (resolveDispatch)
 *   - executionState 判定 (executed / pending_confirmation / skipped / failed)
 *   - idempotency (mutation/external-send の二重実行抑止。read/transport は対象外)
 *   - global tool budget / depth limit (階層跨ぎ再帰の停止性)
 *
 * P2a: ゲートウェイ単体。まだ chat route には未配線 = 挙動不変。
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef, ToolContext, ToolDisposition } from "./types";
import { runTool, resolveDispatch, isDedupSkipResult } from "./runtime";

export type ExecutionState = "executed" | "pending_confirmation" | "skipped" | "failed";

export type DispatchOutcome = {
  executionState: ExecutionState;
  disposition: ToolDisposition;
  result: Anthropic.ToolResultBlockParam;
  /** skipped の理由 (ログ・デバッグ用)。dedup_recent_execution = ターンをまたぐ重複ガード。 */
  skipReason?: "budget" | "duplicate" | "depth" | "dedup_recent_execution";
};

/**
 * ターン単位の実行台帳。idempotency + budget を 1 ターン共有する **単一可変オブジェクト**。
 * 階層 (Executor → agent → specialist → …) を跨いで**同じインスタンスを回す** (コピーしない)
 * ことで総量を正しく制御する。depth は ledger に持たず dispatchTool の引数で渡す (call-stack 値)。
 */
export type DispatchLedger = {
  budgetRemaining: number;
  maxDepth: number;
  /** 実行済 mutation/external-send の (name|正規化input) キー */
  executedMutations: Set<string>;
};

/** 1 ターンで実行できる総ツール呼び出し数の既定上限 (mini-loop MAX_TOOL_ITER とは別の総量キャップ) */
export const DEFAULT_TOOL_BUDGET = 24;
/** dispatchTool ネスト深さの既定上限 (specialist → 内部 tool → …) */
export const DEFAULT_MAX_DEPTH = 4;

export function createDispatchLedger(opts?: { budget?: number; maxDepth?: number }): DispatchLedger {
  return {
    budgetRemaining: opts?.budget ?? DEFAULT_TOOL_BUDGET,
    maxDepth: opts?.maxDepth ?? DEFAULT_MAX_DEPTH,
    executedMutations: new Set(),
  };
}

/**
 * key 安定化 (object のキー順に依存しない正規化)。単一ゲートウェイの契約上 throw しない:
 *   - 循環参照は WeakSet で検出して "[Circular]" に (RangeError を出さない)。
 *   - undefined は null と区別 ("undefined")。
 *   - bigint/function/symbol 等 JSON 化不能な primitive は型名に丸める。
 */
export function stableStringify(v: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (v === undefined) return "undefined";
  if (v === null) return "null";
  if (typeof v !== "object") {
    try {
      const s = JSON.stringify(v);
      return s === undefined ? `"[${typeof v}]"` : s;
    } catch {
      return `"[${typeof v}]"`;
    }
  }
  if (seen.has(v as object)) return '"[Circular]"';
  seen.add(v as object);
  let out: string;
  if (Array.isArray(v)) {
    out = `[${v.map((x) => stableStringify(x, seen)).join(",")}]`;
  } else {
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    out = `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k], seen)}`).join(",")}}`;
  }
  seen.delete(v as object); // 兄弟で共有される非循環参照を誤検出しないよう退出時に外す
  return out;
}

/**
 * idempotency (二重実行抑止) の対象か。
 * mutation / external-send のみ。read-only (`list_*`/`get_*`/`search_*`/web_search) と transport は
 * 再実行を許可する (確認読み・mutation 後の再読込を弾かないため、docs §5.5 / Codex Medium①)。
 */
function isIdempotencyGuarded(tool: ToolDef): boolean {
  return tool.surface === "mutate" || tool.confirmationPolicy === "confirm_external_send";
}

function skipResult(toolUseId: string, reason: string): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify({ skipped: true, reason }),
  };
}

/**
 * 全 tool use はこの関数を通る。tool.handler は呼ぶだけで実装は持たない (役割分離、docs §5.5)。
 *
 * @param ledger ターン共有の単一台帳 (コピーしないで回す)。
 * @param depth  現在のネスト深さ (call-stack 値)。sub-agent/specialist が内部で呼ぶ時は +1 して渡す。
 */
export async function dispatchTool(
  tool: ToolDef,
  tu: { id: string; input: unknown },
  ctx: ToolContext,
  ledger: DispatchLedger,
  depth = 0
): Promise<DispatchOutcome> {
  const dispatch = resolveDispatch(tool);
  const base = { disposition: dispatch.disposition };

  // depth ガード (階層跨ぎ再帰の停止性)
  if (depth > ledger.maxDepth) {
    return { ...base, executionState: "skipped", result: skipResult(tu.id, "depth limit reached"), skipReason: "depth" };
  }
  // budget ガード (総量キャップ)
  if (ledger.budgetRemaining <= 0) {
    return { ...base, executionState: "skipped", result: skipResult(tu.id, "tool budget exhausted"), skipReason: "budget" };
  }
  // idempotency (mutation/external-send の二重実行抑止)
  const guarded = isIdempotencyGuarded(tool);
  const key = `${tool.name}|${stableStringify(tu.input)}`;
  if (guarded && ledger.executedMutations.has(key)) {
    return { ...base, executionState: "skipped", result: skipResult(tu.id, "duplicate mutation suppressed"), skipReason: "duplicate" };
  }

  ledger.budgetRemaining--;
  // guarded mutation は **実行前に予約** して並列二重実行を防ぐ (Codex P2a High)。
  // specialist runner 等が同一 (name,input) を Promise.all で並べても、2 本目は
  // 上の duplicate check で skip される。成功なら予約確定、失敗/pending なら解除して再試行を許す。
  if (guarded) ledger.executedMutations.add(key);

  let result: Anthropic.ToolResultBlockParam;
  try {
    result = await runTool(tool, tu, ctx);
  } catch (e) {
    // runTool は通常 throw しない (handler エラーは is_error で返す) が、単一ゲートウェイ契約上保険。
    if (guarded) ledger.executedMutations.delete(key);
    return {
      ...base,
      executionState: "failed",
      result: {
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }),
        is_error: true,
      },
    };
  }

  // dedup スキップ: runTool が重複でスキップした (confirm/auto 両経路、handler 未実行)。
  // confirmationPolicy 判定より先に振り分ける (confirm tool が「確認待ち」と誤報告されるのを防ぐ)。
  if (isDedupSkipResult(result)) {
    if (guarded) ledger.executedMutations.delete(key); // 実行していない → ターン内予約を解除
    return { ...base, executionState: "skipped", result, skipReason: "dedup_recent_execution" };
  }

  // executionState 判定 (confirmationPolicy ベース。content パースに依存しない)
  let executionState: ExecutionState;
  if (result.is_error) {
    if (guarded) ledger.executedMutations.delete(key); // 失敗 → 再試行可
    executionState = "failed";
  } else if (
    tool.confirmationPolicy === "confirm_destructive" ||
    tool.confirmationPolicy === "confirm_external_send"
  ) {
    // runTool は confirm 必要ツールに対し confirm_required の pending を返す (実行はまだ)
    if (guarded) ledger.executedMutations.delete(key); // pending は未実行 → 再 confirm 可
    executionState = "pending_confirmation";
  } else {
    executionState = "executed"; // 予約を確定
  }

  return { ...base, executionState, result };
}
