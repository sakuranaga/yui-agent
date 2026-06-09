/**
 * ToolDef runtime: registry + Anthropic API 形式変換 + system guard 構築 + runTool。
 *
 * 設計: docs/tool-architecture.md §4.7
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef, ToolContext, ToolMode, ToolCaller } from "./types";
import { ALL_TOOLS } from "./registry";
import { wrapUntrusted, buildUntrustedContentGuard } from "./untrusted-wrap";
import { requestUserConfirm, buildConfirmGuard } from "./confirm";

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
  // tool name から domain 名を抜く
  const headline =
    typeof i.title === "string"
      ? `『${i.title}』を${verb}`
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
      return errorResult(
        tu.id,
        "another confirmation is already pending in this session; ask user to resolve it first"
      );
    }
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
  try {
    const raw = await tool.handler(tu.input, ctx);
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
    return errorResult(tu.id, e instanceof Error ? e.message : String(e));
  }
}
