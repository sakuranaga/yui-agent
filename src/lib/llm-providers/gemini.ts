/**
 * Gemini adapter (generativelanguage.googleapis.com /v1beta)。
 *
 * 入出力を Anthropic.Message 互換形に統一する。
 *
 * 入力翻訳:
 *   - system           → systemInstruction.parts[].text
 *   - messages         → contents[] (role "assistant" → "model")
 *     ・text block         → parts[].text
 *     ・tool_use (asst)    → parts[].functionCall { id?, name, args }
 *     ・tool_result (user) → parts[].functionResponse { id?, name, response }
 *     ・image (user)       → parts[].inlineData { mimeType, data }
 *   - tools            → tools[0].functionDeclarations[]
 *
 * 出力翻訳:
 *   - candidates[0].content.parts[]
 *     ・text         → TextBlock
 *     ・functionCall → ToolUseBlock (id 不在なら name から擬似生成)
 *   - usageMetadata.promptTokenCount / candidatesTokenCount → Anthropic.Usage
 *   - finishReason → stop_reason
 *
 * 既知の制限: Gemini は tool_use の id を保持しない API バージョンがあるため、
 *  同一 tool を 1 turn 内で複数回呼ぶケースで tool_result との対応がズレる
 *  可能性がある。基本シナリオでは問題ない。
 */
import type Anthropic from "@anthropic-ai/sdk";

export type GeminiOpts = {
  apiKey: string;
  model: string;
  maxTokens: number;
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
};

type GeminiPart =
  | { text: string }
  | { functionCall: { id?: string; name: string; args: Record<string, unknown> } }
  | { functionResponse: { id?: string; name: string; response: Record<string, unknown> } }
  | { inlineData: { mimeType: string; data: string } };

type GeminiContent = {
  role: "user" | "model";
  parts: GeminiPart[];
};

type GeminiResponse = {
  candidates?: Array<{
    content?: { role?: string; parts?: GeminiPart[] };
    finishReason?: string;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
};

function flattenSystem(sys: string | Anthropic.TextBlockParam[] | undefined): string | undefined {
  if (sys === undefined) return undefined;
  if (typeof sys === "string") return sys;
  return sys.map((b) => b.text).join("\n\n");
}

/** tool_use_id (Anthropic) → 直近の name を覚えておく map。
 *  Gemini が id を保持しない場合、tool_result を name で照合するため。 */
function buildToolIdToName(messages: Anthropic.MessageParam[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const m of messages) {
    if (m.role !== "assistant" || typeof m.content === "string") continue;
    for (const block of m.content) {
      if (block.type === "tool_use") map.set(block.id, block.name);
    }
  }
  return map;
}

function translateMessages(messages: Anthropic.MessageParam[]): GeminiContent[] {
  const idToName = buildToolIdToName(messages);
  const out: GeminiContent[] = [];

  for (const m of messages) {
    const geminiRole: "user" | "model" = m.role === "assistant" ? "model" : "user";

    if (typeof m.content === "string") {
      out.push({ role: geminiRole, parts: [{ text: m.content }] });
      continue;
    }

    const parts: GeminiPart[] = [];
    for (const block of m.content) {
      if (block.type === "text") {
        parts.push({ text: block.text });
      } else if (block.type === "tool_use" && m.role === "assistant") {
        parts.push({
          functionCall: {
            id: block.id,
            name: block.name,
            args: (block.input as Record<string, unknown>) ?? {},
          },
        });
      } else if (block.type === "tool_result" && m.role === "user") {
        const name = idToName.get(block.tool_use_id) ?? "unknown_tool";
        const responseText =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? [])
                .map((b) => (b.type === "text" ? b.text : ""))
                .join("");
        let response: Record<string, unknown>;
        try {
          // tool result が JSON 文字列ならパース、ダメなら { content: text } に包む
          const parsed = JSON.parse(responseText);
          response = typeof parsed === "object" && parsed !== null
            ? (parsed as Record<string, unknown>)
            : { value: parsed };
        } catch {
          response = { content: responseText };
        }
        parts.push({
          functionResponse: { id: block.tool_use_id, name, response },
        });
      } else if (block.type === "image" && m.role === "user") {
        const src = block.source;
        if (src.type === "base64") {
          parts.push({
            inlineData: { mimeType: src.media_type, data: src.data },
          });
        }
        // URL source は Gemini が現状 inlineData のみ受けるので skip
      }
    }
    if (parts.length > 0) out.push({ role: geminiRole, parts });
  }

  return out;
}

function translateTools(
  tools: Anthropic.Tool[] | undefined
): Array<{ functionDeclarations: Array<{ name: string; description?: string; parameters: object }> }> | undefined {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: (t.input_schema as object) ?? { type: "object", properties: {} },
      })),
    },
  ];
}

function translateFinishReason(
  fr: string | undefined
): Anthropic.Message["stop_reason"] {
  switch (fr) {
    case "MAX_TOKENS": return "max_tokens";
    case "STOP":       return "end_turn";
    case "TOOL_CALLS": return "tool_use"; // 未来形 (現状は STOP + functionCall パーツで判別)
    default:           return "end_turn";
  }
}

function translateResponse(res: GeminiResponse, model: string): Anthropic.Message {
  const cand = res.candidates?.[0];
  if (!cand) throw new Error("Gemini: empty candidates");
  const parts = cand.content?.parts ?? [];

  const content: Anthropic.ContentBlock[] = [];
  let sawToolCall = false;
  for (const p of parts) {
    if ("text" in p && p.text) {
      content.push({ type: "text", text: p.text, citations: [] });
    } else if ("functionCall" in p) {
      sawToolCall = true;
      const fc = p.functionCall;
      content.push({
        type: "tool_use",
        // id を返さない API バージョン用に擬似 ID を生成
        id: fc.id ?? `gemini_${fc.name}_${Math.random().toString(36).slice(2, 10)}`,
        name: fc.name,
        input: fc.args ?? {},
      });
    }
  }

  // finishReason が STOP でも functionCall があれば tool_use stop に直す
  const stop_reason: Anthropic.Message["stop_reason"] = sawToolCall
    ? "tool_use"
    : translateFinishReason(cand.finishReason);

  // Gemini が極稀に candidates を空で返した場合の最低限の "text" 埋め
  if (content.length === 0) {
    content.push({ type: "text", text: "", citations: [] });
  }

  return {
    id: `gemini_${Date.now()}`,
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason,
    stop_sequence: null,
    usage: {
      input_tokens: res.usageMetadata?.promptTokenCount ?? 0,
      output_tokens: res.usageMetadata?.candidatesTokenCount ?? 0,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      cache_creation: null,
      server_tool_use: null,
      service_tier: null,
    },
  } as Anthropic.Message;
}

export async function callGemini(opts: GeminiOpts): Promise<Anthropic.Message> {
  const sys = flattenSystem(opts.system);
  const contents = translateMessages(opts.messages);
  const tools = translateTools(opts.tools);

  const body: Record<string, unknown> = {
    contents,
    generationConfig: { maxOutputTokens: opts.maxTokens },
  };
  if (sys) {
    body.systemInstruction = { parts: [{ text: sys }] };
  }
  if (tools) {
    body.tools = tools;
  }

  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(opts.model)}:generateContent` +
    `?key=${encodeURIComponent(opts.apiKey)}`;

  // eslint-disable-next-line no-restricted-syntax -- Gemini 公式 API endpoint 固定
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    const err = new Error(`Gemini HTTP ${res.status}: ${errText.slice(0, 500)}`);
    (err as { status?: number }).status = res.status;
    throw err;
  }

  const data = (await res.json()) as GeminiResponse;
  return translateResponse(data, opts.model);
}
