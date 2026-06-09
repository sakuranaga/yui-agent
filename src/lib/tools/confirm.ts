/**
 * destructive / external_send tool 用の非同期 confirm フロー。
 *
 * 設計: docs/tool-architecture.md §4.5 (v3 fix)
 *
 * 流れ:
 *   Phase A (= runTool 内):
 *     - requestUserConfirm で pending を Valkey に保存 + SSE で frontend に push
 *     - 同 session に既存 pending あれば {error:"already_pending"} (= 409 相当)
 *     - tool_result.content に {confirm_required: true, token, ...} を返して chat 1 回終了
 *   Phase B (= POST /api/tool-confirm/[token] 経由 background):
 *     - executePendingTool で再検証 (callableBy / allowedModes / confirmationPolicy /
 *       isAvailable) → handler 実行 → 結果 SSE push + Yui 再 turn dispatch
 */
import { pushToSession } from "@/lib/jobs/events";
import { randomBytes } from "node:crypto";
import { cacheGet, cacheSet, cacheDel } from "@/lib/cache";
import type {
  ConfirmationPolicy,
  ToolCaller,
  ToolContext,
  ToolDef,
  ToolMode,
} from "./types";
import { ALL_TOOLS } from "./registry";

const CONFIRM_TTL_SEC = 600; // 10 分

export type ConfirmPending = {
  sessionId: string;
  toolName: string;
  inputSnapshot: unknown;
  caller: ToolCaller;
  mode: ToolMode;
  confirmationPolicy: ConfirmationPolicy;
  summary: string;
  status: "pending" | "confirmed" | "denied" | "executed" | "failed";
  result?: unknown;
  failReason?: string;
  createdAt: number;
};

const PENDING_KEY = (token: string) => `tool-confirm:${token}`;
const SESSION_INDEX_KEY = (sessionId: string) => `tool-confirm:idx:${sessionId}`;

/** 同 session の pending token 一覧 (= 同時 1 件まで判定に使う) */
export async function listPendingForSession(sessionId: string): Promise<string[]> {
  const arr = await cacheGet<string[]>(SESSION_INDEX_KEY(sessionId));
  if (!arr || !Array.isArray(arr)) return [];
  // 期限切れ token を除外 (= 個別 lookup)
  const alive: string[] = [];
  for (const tk of arr) {
    const p = await cacheGet<ConfirmPending>(PENDING_KEY(tk));
    if (p && p.status === "pending") alive.push(tk);
  }
  return alive;
}

async function addToSessionIndex(sessionId: string, token: string): Promise<void> {
  const cur = (await cacheGet<string[]>(SESSION_INDEX_KEY(sessionId))) ?? [];
  cur.push(token);
  await cacheSet(SESSION_INDEX_KEY(sessionId), cur, CONFIRM_TTL_SEC);
}

async function removeFromSessionIndex(sessionId: string, token: string): Promise<void> {
  const cur = (await cacheGet<string[]>(SESSION_INDEX_KEY(sessionId))) ?? [];
  const next = cur.filter((t) => t !== token);
  if (next.length === 0) await cacheDel(SESSION_INDEX_KEY(sessionId));
  else await cacheSet(SESSION_INDEX_KEY(sessionId), next, CONFIRM_TTL_SEC);
}

/**
 * confirm 要求を立てる。chat request 内で同期的に呼ぶ (block しない、すぐ token 返す)。
 * 同 session に未解決 pending あれば 409 相当を返す。
 */
export async function requestUserConfirm(opts: {
  sessionId: string;
  toolName: string;
  summary: string;
  inputSnapshot: unknown;
  caller: ToolCaller;
  mode: ToolMode;
  confirmationPolicy: ConfirmationPolicy;
}): Promise<{ token: string } | { error: "already_pending" }> {
  const existing = await listPendingForSession(opts.sessionId);
  if (existing.length > 0) {
    return { error: "already_pending" };
  }

  const token = randomBytes(16).toString("hex");
  const pending: ConfirmPending = {
    sessionId: opts.sessionId,
    toolName: opts.toolName,
    inputSnapshot: opts.inputSnapshot,
    caller: opts.caller,
    mode: opts.mode,
    confirmationPolicy: opts.confirmationPolicy,
    summary: opts.summary,
    status: "pending",
    createdAt: Date.now(),
  };
  await cacheSet(PENDING_KEY(token), pending, CONFIRM_TTL_SEC);
  await addToSessionIndex(opts.sessionId, token);

  pushToSession(opts.sessionId, {
    type: "tool_confirm_request",
    token,
    toolName: opts.toolName,
    summary: opts.summary,
    inputSnapshot: opts.inputSnapshot,
  });
  return { token };
}

/** decision 受領 → status 書き換え。idempotent (= 既に終端なら何もせず既存値返す) */
export async function applyConfirmDecision(
  token: string,
  decision: "confirmed" | "denied"
): Promise<{ status: ConfirmPending["status"]; pending: ConfirmPending | null }> {
  const p = await cacheGet<ConfirmPending>(PENDING_KEY(token));
  if (!p) return { status: "denied", pending: null };
  if (p.status !== "pending") return { status: p.status, pending: p };
  p.status = decision;
  await cacheSet(PENDING_KEY(token), p, CONFIRM_TTL_SEC);

  // denied は ここで SSE push + 内部 chat 再 turn まで完了 (= Yui「やめておきます」)
  if (decision === "denied") {
    await removeFromSessionIndex(p.sessionId, token);
    pushToSession(p.sessionId, {
      type: "tool_confirm_result",
      token,
      success: false,
      reason: "user denied",
    });
    void dispatchPostConfirmYuiTurn({
      sessionId: p.sessionId,
      token,
      toolName: p.toolName,
      summary: p.summary,
      success: false,
      reason: "user denied",
    }).catch((e) => {
      console.warn(`[tool-confirm/${token}] post-deny dispatch failed:`, e);
    });
  }
  return { status: decision, pending: p };
}

function callerMatches(declared: ToolCaller, actual: ToolCaller): boolean {
  if (declared.kind !== actual.kind) return false;
  if (declared.kind === "specialist") {
    return declared.id === (actual as { kind: "specialist"; id: string }).id;
  }
  return true;
}

async function markFailed(token: string, reason: string): Promise<void> {
  const p = await cacheGet<ConfirmPending>(PENDING_KEY(token));
  if (!p) return;
  p.status = "failed";
  p.failReason = reason;
  await cacheSet(PENDING_KEY(token), p, CONFIRM_TTL_SEC);
  await removeFromSessionIndex(p.sessionId, token);
  pushToSession(p.sessionId, {
    type: "tool_confirm_result",
    token,
    success: false,
    reason,
  });
  // Phase B 再 turn: 失敗理由を Yui が会話に反映させる
  // (= 「再検証失敗で実行できませんでした、〜の理由です」を口頭報告)
  void dispatchPostConfirmYuiTurn({
    sessionId: p.sessionId,
    token,
    toolName: p.toolName,
    summary: p.summary,
    success: false,
    reason,
  }).catch((e) => {
    console.warn(`[tool-confirm/${token}] post-fail dispatch failed:`, e);
  });
}

async function markExecuted(token: string, result: unknown): Promise<void> {
  const p = await cacheGet<ConfirmPending>(PENDING_KEY(token));
  if (!p) return;
  p.status = "executed";
  p.result = result;
  await cacheSet(PENDING_KEY(token), p, CONFIRM_TTL_SEC);
  await removeFromSessionIndex(p.sessionId, token);
  pushToSession(p.sessionId, {
    type: "tool_confirm_result",
    token,
    success: true,
    result,
  });
  // Phase B 再 turn: Yui に結果を踏まえた最終発話を生成させる (= specialist 完了報告と同経路)
  void dispatchPostConfirmYuiTurn({
    sessionId: p.sessionId,
    token,
    toolName: p.toolName,
    summary: p.summary,
    success: true,
    result,
  }).catch((e) => {
    console.warn(`[tool-confirm/${token}] post-execute dispatch failed:`, e);
  });
}

/**
 * confirm 完了 (= confirmed → executed もしくは denied) 後、Yui に内部 chat の
 * 再 turn を回して「○○しました」「やめておきます」等の最終発話を生成させる。
 * SSE で frontend に届くので user 視点では chat の続きとして見える。
 */
async function dispatchPostConfirmYuiTurn(opts: {
  sessionId: string;
  token: string;
  toolName: string;
  summary: string;
  success: boolean;
  result?: unknown;
  reason?: string;
}): Promise<void> {
  const { internalFetch } = await import("@/lib/internal-fetch");
  const port = process.env.PORT ?? "3000";
  await internalFetch(`http://localhost:${port}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [],
      sessionId: opts.sessionId,
      source: "tool_confirm_result",
      toolConfirmResult: {
        token: opts.token,
        toolName: opts.toolName,
        summary: opts.summary,
        success: opts.success,
        result: opts.result ?? null,
        reason: opts.reason ?? null,
      },
    }),
  });
}

/**
 * Phase B: confirmed pending を取り出し、再検証 → handler 実行 → SSE で結果 push。
 * background job として fire-and-forget で呼ぶ (= POST /api/tool-confirm の中)。
 */
export async function executePendingTool(token: string): Promise<void> {
  const pending = await cacheGet<ConfirmPending>(PENDING_KEY(token));
  if (!pending) return;
  if (pending.status !== "confirmed") return;

  // 1. registry から tool 再取得
  const tool: ToolDef | undefined = ALL_TOOLS.find((t) => t.name === pending.toolName);
  if (!tool) {
    return markFailed(token, "tool no longer registered");
  }

  // 2. callableBy 再検証
  if (!tool.callableBy.some((c) => callerMatches(c, pending.caller))) {
    return markFailed(token, "caller boundary changed since pending");
  }

  // 3. allowedModes 再検証
  if (!tool.allowedModes.includes(pending.mode)) {
    return markFailed(token, "mode no longer allowed since pending");
  }

  // 4. confirmationPolicy 再検証
  if (tool.confirmationPolicy !== pending.confirmationPolicy) {
    return markFailed(token, "confirmation policy changed since pending");
  }

  // 5. isAvailable 再判定
  if (tool.isAvailable) {
    const availabilityCache = new Map<string, Promise<boolean>>();
    const ok = await tool.isAvailable({
      sessionId: pending.sessionId,
      availabilityCache,
    });
    if (!ok) {
      return markFailed(
        token,
        "tool no longer available (OAuth scope or service status changed)"
      );
    }
  }

  // 全部 pass → handler 実行
  try {
    const ctx: ToolContext = {
      sessionId: pending.sessionId,
      caller: pending.caller,
      mode: pending.mode,
      userUtterance: null,
      availabilityCache: new Map(),
    };
    const result = await tool.handler(pending.inputSnapshot, ctx);
    await markExecuted(token, result);
  } catch (e) {
    await markFailed(token, e instanceof Error ? e.message : String(e));
  }
}

/** system guard 文 (confirm 系 tool が露出してる時に inject) */
export function buildConfirmGuard(): string {
  return [
    "[user-confirm-policy]",
    "tool_result の content に { \"confirm_required\": true, \"token\": ... } が含まれる場合:",
    "- その tool は user の能動 click 待ち状態です。実行はまだされていません。",
    "- text response で「○○して良いかご確認お願いします」と短く伝え、turn を終わらせてください。",
    "- 同じ pending について同一ターンで何度も呼んだり、別の destructive tool を続けて呼ばないでください。",
    "- user の click 結果は別ターンで届きます (= ここでは追加のツール呼び出し不要)。",
  ].join("\n");
}
