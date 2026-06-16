/**
 * OpenAI / Grok adapter (Chat Completions API)。
 *
 * 入出力を Anthropic.Message 互換形に統一して、呼び出し側 (callLlm / chat loop) を
 * 改修不要にする。Grok (xAI) は OpenAI 互換 API なので `baseUrl` 切替で再利用。
 *
 * 入力翻訳:
 *   - system (string | TextBlockParam[]) → role="system" 1 メッセージにフラット化
 *     (cache_control は OpenAI に概念無いので無視)
 *   - messages (Anthropic.MessageParam[]) → OpenAI messages
 *     ・text block            → content text
 *     ・tool_use block (asst) → assistant の tool_calls
 *     ・tool_result block (user) → role="tool" メッセージ (tool_call_id 付き)
 *     ・image block           → content parts (image_url)
 *   - tools (Anthropic.Tool[]) → tools = [{ type: "function", function: {...} }]
 *
 * 出力翻訳:
 *   - choices[0].message.content (string|null)  → TextBlock
 *   - choices[0].message.tool_calls[]            → ToolUseBlock (args JSON.parse)
 *   - usage                                       → Anthropic.Usage
 *   - finish_reason                               → stop_reason
 */
import type Anthropic from "@anthropic-ai/sdk";

export type OpenAICompatOpts = {
  apiKey: string;
  baseUrl: string; // 例: "https://api.openai.com/v1" or "https://api.x.ai/v1"
  model: string;
  maxTokens: number;
  /** max_tokens のパラメータ名。OpenAI の新モデル (GPT-5 / o-series) は
   *  "max_completion_tokens" 必須。Grok は "max_tokens" を受け付ける。
   *  default は "max_completion_tokens" (OpenAI 想定) */
  tokenParamName?: "max_tokens" | "max_completion_tokens";
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  /** tool-use を誘導/強制 (能力テスト等)。"auto" or 特定 tool 名を強制。 */
  toolChoice?: "auto" | { name: string };
};

type OAIMessage =
  | { role: "system"; content: string }
  | { role: "user"; content: string | OAIContentPart[] }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: Array<{
        id: string;
        type: "function";
        function: { name: string; arguments: string };
      }>;
    }
  | { role: "tool"; tool_call_id: string; content: string };

type OAIContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

type OAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OAIResponse = {
  id: string;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: "assistant";
      content: string | null;
      tool_calls?: OAIToolCall[];
    };
    finish_reason: "stop" | "tool_calls" | "length" | "content_filter" | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

function flattenSystem(sys: string | Anthropic.TextBlockParam[] | undefined): string | undefined {
  if (sys === undefined) return undefined;
  if (typeof sys === "string") return sys;
  return sys.map((b) => b.text).join("\n\n");
}

/** Anthropic MessageParam[] を OpenAI messages 形式に翻訳 */
function translateMessages(messages: Anthropic.MessageParam[]): OAIMessage[] {
  const out: OAIMessage[] = [];

  for (const m of messages) {
    if (typeof m.content === "string") {
      out.push({ role: m.role, content: m.content } as OAIMessage);
      continue;
    }

    // content は ContentBlock[] (text / tool_use / tool_result / image / document …)
    if (m.role === "assistant") {
      // assistant: text + tool_use のミックス想定
      let text = "";
      const toolCalls: OAIToolCall[] = [];
      for (const block of m.content) {
        if (block.type === "text") {
          text += block.text;
        } else if (block.type === "tool_use") {
          toolCalls.push({
            id: block.id,
            type: "function",
            function: {
              name: block.name,
              arguments: JSON.stringify(block.input ?? {}),
            },
          });
        }
        // thinking / redacted_thinking 等は OpenAI に概念無いので drop
      }
      const msg: OAIMessage = {
        role: "assistant",
        content: text.length > 0 ? text : null,
      };
      if (toolCalls.length > 0) {
        (msg as { tool_calls?: OAIToolCall[] }).tool_calls = toolCalls;
      }
      out.push(msg);
      continue;
    }

    // user: text / image / tool_result のミックス想定。tool_result は別メッセージに分割。
    const userParts: OAIContentPart[] = [];
    for (const block of m.content) {
      if (block.type === "text") {
        userParts.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        const src = block.source;
        let url = "";
        if (src.type === "base64") {
          url = `data:${src.media_type};base64,${src.data}`;
        } else if (src.type === "url") {
          url = src.url;
        }
        if (url) userParts.push({ type: "image_url", image_url: { url } });
      } else if (block.type === "tool_result") {
        // 直前までの user parts があれば user msg として flush
        if (userParts.length > 0) {
          out.push({
            role: "user",
            content: userParts.length === 1 && userParts[0].type === "text"
              ? userParts[0].text
              : [...userParts],
          });
          userParts.length = 0;
        }
        // tool_result の content (string | block[]) → string に
        const content =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? [])
                .map((b) => (b.type === "text" ? b.text : ""))
                .join("");
        out.push({ role: "tool", tool_call_id: block.tool_use_id, content });
      }
    }
    if (userParts.length > 0) {
      out.push({
        role: "user",
        content: userParts.length === 1 && userParts[0].type === "text"
          ? userParts[0].text
          : userParts,
      });
    }
  }

  return out;
}

function translateTools(tools: Anthropic.Tool[] | undefined): Array<{
  type: "function";
  function: { name: string; description?: string; parameters: object };
}> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: (t.input_schema as object) ?? { type: "object", properties: {} },
    },
  }));
}

function translateFinishReason(
  fr: string | null | undefined
): Anthropic.Message["stop_reason"] {
  switch (fr) {
    case "tool_calls": return "tool_use";
    case "length":     return "max_tokens";
    case "stop":       return "end_turn";
    default:           return "end_turn";
  }
}

/** OpenAI 応答を Anthropic.Message 互換形に詰め直す */
function translateResponse(res: OAIResponse, model: string): Anthropic.Message {
  const choice = res.choices[0];
  if (!choice) {
    throw new Error("OpenAI: empty choices");
  }
  const content: Anthropic.ContentBlock[] = [];
  if (choice.message.content && choice.message.content.length > 0) {
    content.push({
      type: "text",
      text: choice.message.content,
      citations: [],
    });
  }
  for (const tc of choice.message.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = JSON.parse(tc.function.arguments || "{}");
    } catch (e) {
      console.warn("[openai-adapter] failed to parse tool arguments:", tc.function.arguments, e);
      input = { _raw: tc.function.arguments };
    }
    content.push({
      type: "tool_use",
      id: tc.id,
      name: tc.function.name,
      input,
    });
  }

  return {
    id: res.id,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: translateFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: res.usage?.prompt_tokens ?? 0,
      output_tokens: res.usage?.completion_tokens ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message;
}

/** reasoning model (内部 reasoning token を消費するモデル) を判定 */
function isReasoningModel(model: string): boolean {
  const m = model.toLowerCase();
  return (
    m.startsWith("gpt-5") ||
    m.startsWith("o1") ||
    m.startsWith("o3") ||
    m.startsWith("o4")
  );
}

/**
 * 「reasoning を最小化したい」時に渡す effort 値。
 *
 * 経緯: gpt-5.X の世代 / variant ごとに supported values が異なる:
 *   - gpt-5 / gpt-5.1: "minimal" | "low" | "medium" | "high"
 *   - gpt-5.2 (一部):  "none" | "low" | "medium" | "high" | "xhigh"
 *   - 5.x の他 variant: "none" | "low" | "medium" | "high"  (minimal/xhigh 無し)
 * 全モデル共通で動くのは **"low"** のみ。"minimal" は token 効率が若干良いが
 * 互換性のために常に "low" を返す (= ROI 小)。
 */
function minimalReasoningEffort(_model: string): "low" {
  return "low";
}

/**
 * tools + reasoning_effort の組み合わせが /v1/chat/completions で 400 になるモデルか判定。
 *
 * gpt-5.4 以降は OpenAI が /v1/responses への移行を要求 (= function tools と reasoning_effort
 * の併用は新 API でしかサポートしないポリシー)。Yui は tool 必須なので、これらのモデルでは
 * reasoning_effort を送らず、API デフォルト挙動に委ねる。
 */
function omitReasoningEffortForTools(model: string, hasTools: boolean): boolean {
  if (!hasTools) return false;
  const v = model.toLowerCase().match(/^gpt-5\.(\d+)/);
  return !!v && parseInt(v[1], 10) >= 4;
}

export async function callOpenAICompat(opts: OpenAICompatOpts): Promise<Anthropic.Message> {
  const messages: OAIMessage[] = [];
  const sys = flattenSystem(opts.system);
  if (sys) messages.push({ role: "system", content: sys });
  messages.push(...translateMessages(opts.messages));

  const tokenParam = opts.tokenParamName ?? "max_completion_tokens";
  const reasoning = isReasoningModel(opts.model);
  // reasoning model は max_completion_tokens に内部 reasoning token も含まれる。
  // Yui のデフォルト max=400 だと reasoning に食われて output 0 になるので、
  //   reasoning_effort: "minimal" (gpt-5) / "low" (o-series) で reasoning を抑制
  //   かつ最低 2000 token を確保して output 余地を残す。
  const effectiveTokens = reasoning ? Math.max(opts.maxTokens, 2000) : opts.maxTokens;

  const body: Record<string, unknown> = {
    model: opts.model,
    [tokenParam]: effectiveTokens,
    messages,
  };
  const tools = translateTools(opts.tools);
  if (tools) body.tools = tools;
  if (tools && opts.toolChoice) {
    body.tool_choice =
      opts.toolChoice === "auto"
        ? "auto"
        : { type: "function", function: { name: opts.toolChoice.name } };
  }
  if (reasoning && !omitReasoningEffortForTools(opts.model, !!tools)) {
    body.reasoning_effort = minimalReasoningEffort(opts.model);
  }

  // eslint-disable-next-line no-restricted-syntax -- OpenAI 互換 API (= 公式 OpenAI / xAI Grok)、baseUrl は env 由来の信頼 endpoint
  const res = await fetch(`${opts.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${opts.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`OpenAI-compat HTTP ${res.status}: ${errText.slice(0, 500)}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }

  const data = (await res.json()) as OAIResponse;
  return translateResponse(data, opts.model);
}
