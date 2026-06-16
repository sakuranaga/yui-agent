/**
 * レジストリ entry を直接呼ぶ per-entry dispatcher + 能力テスト (#206 M2)。
 *
 * callModelDirect: ModelEntry の provider に従って LLM を呼ぶ (callLlm の role 解決を経由しない)。
 *   M3 で callLlm がこれを resolveTier 経由で使うようになる (= 共有コア)。
 * testModelCapabilities: 到達性 + tool-use を probe し capabilities を返す。
 *
 * provider 別: anthropic=SDK / openai・grok・local_openai=OpenAI 互換 / gemini=REST。
 */
import Anthropic from "@anthropic-ai/sdk";
import { getAiSetting } from "@/lib/ai-settings";
import { callOpenAICompat } from "@/lib/llm-providers/openai";
import { callGemini } from "@/lib/llm-providers/gemini";
import { updateModel, type ModelEntry, type ModelProvider } from "@/lib/model-registry";
import type { ModelCapabilities } from "@/db/schema";

export type LlmToolChoice = "auto" | { name: string };

export type DirectCallOpts = {
  system?: string | Anthropic.TextBlockParam[];
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  toolChoice?: LlmToolChoice;
  maxTokens?: number;
};

// 現状 provider ごとに単一 API キーを ai_settings に持つ前提なので、entry.apiKeyRef
// (将来の複数キー対応用) は参照せず provider から固定で引く。M4 以降で apiKeyRef を
// 実際に複数キーへ解決する時にここを差し替える。
async function keyForProvider(provider: ModelProvider): Promise<string | null> {
  switch (provider) {
    case "anthropic": return getAiSetting("anthropic_api_key");
    case "openai": return getAiSetting("openai_api_key");
    case "gemini": return getAiSetting("gemini_api_key");
    case "grok": return getAiSetting("grok_api_key");
    case "local_openai": return null; // local は基本 auth 不要
  }
}

/** レジストリ entry を直接呼ぶ。provider に従って各アダプタへ振り分け。 */
export async function callModelDirect(
  entry: ModelEntry,
  opts: DirectCallOpts
): Promise<Anthropic.Message> {
  const maxTokens = opts.maxTokens ?? 256;
  const hasTools = !!opts.tools && opts.tools.length > 0;

  if (entry.provider === "anthropic") {
    const apiKey = await keyForProvider("anthropic");
    if (!apiKey) throw new Error("anthropic API key 未設定");
    const client = new Anthropic({ apiKey });
    return client.messages.create({
      model: entry.modelId,
      max_tokens: maxTokens,
      ...(opts.system !== undefined ? { system: opts.system } : {}),
      messages: opts.messages,
      ...(hasTools ? { tools: opts.tools } : {}),
      ...(hasTools && opts.toolChoice
        ? {
            tool_choice:
              opts.toolChoice === "auto"
                ? { type: "auto" as const }
                : { type: "tool" as const, name: opts.toolChoice.name },
          }
        : {}),
    });
  }

  if (entry.provider === "gemini") {
    const apiKey = await keyForProvider("gemini");
    if (!apiKey) throw new Error("gemini API key 未設定");
    return callGemini({
      apiKey,
      model: entry.modelId,
      maxTokens,
      system: opts.system,
      messages: opts.messages,
      tools: opts.tools,
      toolChoice: opts.toolChoice,
    });
  }

  // openai | grok | local_openai (= OpenAI 互換)
  let baseUrl: string;
  let apiKey: string;
  let tokenParamName: "max_tokens" | "max_completion_tokens";
  if (entry.provider === "openai") {
    const k = await keyForProvider("openai");
    if (!k) throw new Error("openai API key 未設定");
    baseUrl = "https://api.openai.com/v1";
    apiKey = k;
    tokenParamName = "max_completion_tokens";
  } else if (entry.provider === "grok") {
    const k = await keyForProvider("grok");
    if (!k) throw new Error("grok API key 未設定");
    baseUrl = "https://api.x.ai/v1";
    apiKey = k;
    tokenParamName = "max_tokens";
  } else {
    // local_openai
    if (!entry.baseUrl) throw new Error("local_openai は base_url 必須");
    baseUrl = entry.baseUrl;
    apiKey = "noauth"; // 多くのローカルサーバは Bearer を無視する
    tokenParamName = "max_tokens";
  }
  return callOpenAICompat({
    apiKey,
    baseUrl,
    model: entry.modelId,
    maxTokens,
    tokenParamName,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    toolChoice: opts.toolChoice,
  });
}

// ───── 能力テスト ─────

const PROBE_TOOL: Anthropic.Tool = {
  name: "echo",
  description: "Echo the given text back verbatim.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string", description: "the text to echo" } },
    required: ["text"],
  },
};

/** エラーを安全なカテゴリに丸める (CLAUDE.md: 生メッセージを返さない)。 */
function categorizeErr(e: unknown): string {
  const status = (e as { status?: number })?.status;
  if (typeof status === "number") return `HTTP ${status}`;
  const msg = e instanceof Error ? e.message : String(e);
  if (/timeout|abort/i.test(msg)) return "timeout";
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo|DNS/i.test(msg)) return "DNS resolution failed";
  if (/ECONNREFUSED|connect/i.test(msg)) return "connection refused";
  if (/未設定/.test(msg)) return msg; // 「xxx API key 未設定」は安全
  return "unknown error";
}

/**
 * entry の能力をテストする: ① 到達性 (ping) ② tool-use (echo を tool_choice で強制)。
 * 結果の capabilities を返す (= 呼び側が保存)。生エラーは categorize して lastError に。
 */
export async function testModelCapabilities(entry: ModelEntry): Promise<ModelCapabilities> {
  const cap: ModelCapabilities = {
    reachable: false,
    supportsTools: false,
    testedAt: new Date().toISOString(),
    lastError: null,
  };

  // ① 到達性 + 基本補完 (設計書 §2.3-1: 2xx かつ非空テキストが返れば reachable)
  try {
    const res = await callModelDirect(entry, {
      messages: [{ role: "user", content: "ping" }],
      maxTokens: 16,
    });
    const hasText = res.content.some((b) => b.type === "text" && b.text.trim().length > 0);
    if (!hasText) {
      // 2xx だが補完テキストが空 = endpoint は応えるがモデル応答が成立していない
      cap.lastError = "応答テキストが空 (到達したが補完が成立せず)";
      return cap; // reachable=false のまま、tool 判定はしない
    }
    cap.reachable = true;
  } catch (e) {
    console.warn(`[model-test] ${entry.label} unreachable:`, e instanceof Error ? e.message : e);
    cap.lastError = categorizeErr(e);
    return cap; // 到達できなければ tool 判定はしない
  }

  // ② tool-use probe (echo を強制 → tool_use ブロックが返れば対応)
  try {
    const res = await callModelDirect(entry, {
      messages: [{ role: "user", content: "Use the echo tool to echo the word: hello" }],
      tools: [PROBE_TOOL],
      toolChoice: { name: "echo" },
      maxTokens: 128,
    });
    cap.supportsTools = res.content.some((b) => b.type === "tool_use");
    if (!cap.supportsTools) cap.lastError = "tool_use 応答なし (= 非対応の可能性)";
  } catch (e) {
    // tools を受け付けない endpoint は 4xx 等で throw → 非対応扱い (到達は OK のまま)
    console.warn(`[model-test] ${entry.label} tool probe failed:`, e instanceof Error ? e.message : e);
    cap.supportsTools = false;
    cap.lastError = `tool 非対応 (${categorizeErr(e)})`;
  }

  return cap;
}

/** テストを実行し、結果を entry に保存して返す。 */
export async function testAndSaveCapabilities(entry: ModelEntry): Promise<ModelCapabilities> {
  const cap = await testModelCapabilities(entry);
  const saved = await updateModel(entry.id, { capabilities: cap });
  if (!saved) {
    // テスト中に entry が削除された等。成功レスポンスを返さず route 側 clientError に落とす。
    throw new Error(`model ${entry.id} の capabilities 保存に失敗 (entry が存在しない)`);
  }
  return cap;
}
