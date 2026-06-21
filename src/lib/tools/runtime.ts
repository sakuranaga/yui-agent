/**
 * ToolDef runtime: registry + Anthropic API 形式変換 + system guard 構築 + runTool。
 *
 * 設計: docs/tool-architecture.md §4.7
 */
import type Anthropic from "@anthropic-ai/sdk";
import type {
  ToolDef,
  ToolContext,
  ToolMode,
  ToolCaller,
  ToolDispatch,
  ToolDisposition,
} from "./types";
import { ALL_TOOLS } from "./registry";
import { wrapUntrusted, buildUntrustedContentGuard } from "./untrusted-wrap";
import { requestUserConfirm, buildConfirmGuard } from "./confirm";
import {
  dedupCheckAndReserve,
  finalizeReservation,
  setReservationConfirmToken,
} from "./dedup-guard";

function callerMatches(declared: ToolCaller, actual: ToolCaller): boolean {
  if (declared.kind !== actual.kind) return false;
  if (declared.kind === "specialist") {
    return declared.id === (actual as { kind: "specialist"; id: string }).id;
  }
  return true;
}

/**
 * 露出 tool を 3 軸 (mode / caller / availability) で絞る。
 *   - mode: 静的 (allowedModes)
 *   - caller: 静的 (callableBy) — specialist 境界を構造保証
 *   - availability: 動的 (isAvailable) — 未連携 service を隠す
 */
export async function toolsForContext(ctx: {
  mode: ToolMode;
  caller: ToolCaller;
  sessionId: string;
  availabilityCache: Map<string, Promise<boolean>>;
}): Promise<ToolDef[]> {
  const staticPassed = ALL_TOOLS.filter(
    (t) =>
      t.allowedModes.includes(ctx.mode) &&
      t.callableBy.some((c) => callerMatches(c, ctx.caller))
  );
  const checked = await Promise.all(
    staticPassed.map(async (t) => {
      if (!t.isAvailable) return t;
      const key = t.availabilityKey ?? `tool:${t.name}`;
      let p = ctx.availabilityCache.get(key);
      if (!p) {
        p = t.isAvailable({
          sessionId: ctx.sessionId,
          availabilityCache: ctx.availabilityCache,
        });
        ctx.availabilityCache.set(key, p);
      }
      const ok = await p;
      return ok ? t : null;
    })
  );
  return checked.filter((t): t is ToolDef => t !== null);
}

/** Anthropic API に渡す形に変換 */
export function toAnthropicTools(tools: ToolDef[]): Anthropic.Tool[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.input_schema as Anthropic.Tool["input_schema"],
  }));
}

// ── ディスパッチ方針の推定 (docs/tool-dispatch-redesign.md §4.2) ──
// P1: 推定 + 上書き解決のみ。挙動は変えない (消費は後続フェーズ)。

/**
 * surface / confirmationPolicy から disposition を保守的に推定。
 *   - confirm 必要 (削除/外部送信) → report (黙って投げっぱなし禁止)
 *   - read / external (検索・取得) → report (データを会話へ)
 *   - mutate / transport (純ローカル行動) → silent (B の ack で完結)
 *   - 不明 → report (保守側)
 * 外部サービス mutate で report にしたい等は ToolDef.dispatch で上書き。
 */
function inferDisposition(tool: ToolDef): ToolDisposition {
  if (
    tool.confirmationPolicy === "confirm_destructive" ||
    tool.confirmationPolicy === "confirm_external_send"
  ) {
    return "report";
  }
  switch (tool.surface) {
    case "read":
    case "external":
      return "report";
    case "mutate":
    case "transport":
      return "silent";
    default:
      return "report";
  }
}

/**
 * ツールの実効ディスパッチ方針を解決する。
 * 既定推定 (inferDisposition / executor=inline) に ToolDef.dispatch を部分上書きで重ねる。
 * ただし confirm 必要ツールは **上書きでも silent にできない** = 最後に report を強制する
 * (黙って投げっぱなし禁止、docs §4.2)。
 */
export function resolveDispatch(tool: ToolDef): ToolDispatch {
  const requiresReport =
    tool.confirmationPolicy === "confirm_destructive" ||
    tool.confirmationPolicy === "confirm_external_send";
  const disposition: ToolDisposition = requiresReport
    ? "report"
    : tool.dispatch?.disposition ?? inferDisposition(tool);
  return {
    disposition,
    executor: tool.dispatch?.executor ?? "inline",
    systemPrompt: tool.dispatch?.systemPrompt,
  };
}

/** 露出 tool 群に応じて system guard を組み立てる */
export function buildSystemGuards(exposedTools: ToolDef[]): Anthropic.TextBlockParam[] {
  const guards: Anthropic.TextBlockParam[] = [];
  if (exposedTools.some((t) => t.untrustedOutput)) {
    guards.push({ type: "text", text: buildUntrustedContentGuard() });
  }
  if (
    exposedTools.some(
      (t) =>
        t.confirmationPolicy === "confirm_destructive" ||
        t.confirmationPolicy === "confirm_external_send"
    )
  ) {
    guards.push({ type: "text", text: buildConfirmGuard() });
  }
  return guards;
}

/** confirm modal で表示する 1 行 summary を作る (= input snapshot から人間可読に) */
function buildToolSummary(tool: ToolDef, input: unknown): string {
  // MVP: tool name + input の主要 field を素朴に整形。tool 個別の summary builder は将来拡張
  const i = (input ?? {}) as Record<string, unknown>;
  const verb =
    tool.confirmationPolicy === "confirm_destructive"
      ? "削除します"
      : tool.confirmationPolicy === "confirm_external_send"
        ? "送信します"
        : "実行します";
  const fmtTime = (v: unknown): string => {
    if (!v || typeof v !== "object") return "";
    const t = v as Record<string, unknown>;
    if (typeof t.date === "string") return t.date;
    if (typeof t.dateTime !== "string") return "";
    const d = new Date(t.dateTime);
    if (Number.isNaN(d.getTime())) return t.dateTime;
    const f = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      hour12: false,
    });
    return f.format(d);
  };
  if (tool.name === "gcal_create_event" && typeof i.summary === "string") {
    const start = fmtTime(i.start);
    const end = fmtTime(i.end);
    const loc = typeof i.location === "string" && i.location ? ` @ ${i.location}` : "";
    const when = start ? ` (${end ? `${start} - ${end}` : start})` : "";
    return `予定「${i.summary}」${when}${loc}を登録します`;
  }
  if (tool.name === "gcal_delete_event") {
    const title =
      typeof i.summary === "string" && i.summary
        ? `「${i.summary}」`
        : typeof i.title === "string" && i.title
          ? `「${i.title}」`
          : typeof i.event_id === "string"
            ? i.event_id
            : "予定";
    const start = typeof i.start_jst === "string" ? i.start_jst : "";
    const end = typeof i.end_jst === "string" ? i.end_jst : "";
    const when = start ? ` (${end ? `${start} - ${end}` : start})` : "";
    return `予定${title}${when}を削除します`;
  }
  // tool name から domain 名を抜く
  const headline =
    typeof i.title === "string"
      ? `『${i.title}』を${verb}`
      : typeof i.summary === "string"
        ? `『${i.summary}』を${verb}`
      : typeof i.event_id === "string"
        ? `予定 ${i.event_id} を${verb}`
        : typeof i.id === "string" || typeof i.id === "number"
          ? `id=${String(i.id)} を${verb}`
          : `${tool.name} を${verb}`;
  return headline;
}

function errorResult(toolUseId: string, msg: string): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify({ error: msg }),
    is_error: true,
  };
}

/** dedup 重複でスキップした時の tool_result。C (speak) が「既に同じ内容を実行済み」と報告する。 */
function dedupSkipResult(toolUseId: string, toolName: string): Anthropic.ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: JSON.stringify({
      duplicate_skipped: true,
      tool_name: toolName,
      message:
        "直近に同じ内容を実行済みのため、重複登録を避けてスキップしました。新規には登録していません。",
    }),
  };
}

/** dispatch が dedup スキップを executionState=skipped に振り分けるための判定 (content マーカー)。 */
export function isDedupSkipResult(result: Anthropic.ToolResultBlockParam): boolean {
  if (result.is_error) return false;
  const c = result.content;
  if (typeof c !== "string") return false;
  try {
    return (JSON.parse(c) as { duplicate_skipped?: unknown }).duplicate_skipped === true;
  } catch {
    return false;
  }
}

/** untrusted ラップに同梱する _meta (= 例: web_fetch の URL) を抜き出す */
function extractUntrustedMeta(tool: ToolDef, input: unknown): Record<string, unknown> | undefined {
  const i = (input ?? {}) as Record<string, unknown>;
  if (tool.name === "web_fetch" && typeof i.url === "string") {
    return { url: i.url };
  }
  if (tool.name === "gmail_search" && typeof i.query === "string") {
    return { query: i.query };
  }
  return undefined;
}

/** tool_use を受けて handler を実行し、metadata 駆動で tool_result を返す */
export async function runTool(
  tool: ToolDef,
  tu: { id: string; input: unknown },
  ctx: ToolContext
): Promise<Anthropic.ToolResultBlockParam> {
  // 1. confirm policy: pending tool_result を即返して chat を 1 回終了 (= 非同期 flow)
  if (
    tool.confirmationPolicy === "confirm_destructive" ||
    tool.confirmationPolicy === "confirm_external_send"
  ) {
    // dedup: 確認ダイアログを出す前に重複チェック (reservation = pending_confirmation)。
    const ded = await dedupCheckAndReserve(tool, tu.input, ctx, "pending_confirmation");
    if (ded?.duplicate) return dedupSkipResult(tu.id, tool.name);

    const summary = buildToolSummary(tool, tu.input);
    const res = await requestUserConfirm({
      sessionId: ctx.sessionId,
      toolName: tool.name,
      summary,
      inputSnapshot: tu.input,
      caller: ctx.caller,
      mode: ctx.mode,
      confirmationPolicy: tool.confirmationPolicy,
    });
    if ("error" in res) {
      // 確認を作れなかった → reservation を解放 (failed)。
      if (ded) await finalizeReservation(ded.reservationId, "failed");
      return errorResult(
        tu.id,
        "another confirmation is already pending in this session; ask user to resolve it first"
      );
    }
    // reservation に confirm_token を紐付け (executePendingTool が承認/拒否時に確定)。
    if (ded) await setReservationConfirmToken(ded.reservationId, res.token);
    return {
      type: "tool_result",
      tool_use_id: tu.id,
      content: JSON.stringify({
        confirm_required: true,
        token: res.token,
        tool_name: tool.name,
        summary,
        input_snapshot: tu.input,
      }),
    };
  }

  // 2. handler 実行 (= "auto" policy のみここまで到達)
  // dedup: handler 実行前に重複チェック (reservation = executing)。
  const ded = await dedupCheckAndReserve(tool, tu.input, ctx, "executing");
  if (ded?.duplicate) return dedupSkipResult(tu.id, tool.name);
  try {
    const raw = await tool.handler(tu.input, ctx);
    if (ded) await finalizeReservation(ded.reservationId, "executed");
    if (tool.untrustedOutput) {
      const meta = extractUntrustedMeta(tool, tu.input);
      return {
        type: "tool_result",
        tool_use_id: tu.id,
        content: [
          { type: "text", text: wrapUntrusted(tool.domain, raw, meta) },
        ],
      };
    }
    return {
      type: "tool_result",
      tool_use_id: tu.id,
      content: JSON.stringify(raw),
    };
  } catch (e) {
    if (ded) await finalizeReservation(ded.reservationId, "failed");
    return errorResult(tu.id, e instanceof Error ? e.message : String(e));
  }
}
