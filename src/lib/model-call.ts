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
  /** sampling temperature (未指定なら各 provider の API 既定)。 */
  temperature?: number;
  /** ローカル thinking 制御 (#206 §8.9): false=抑制 / true=強制 ON / undefined=サーバ既定。
   *  callModelDirect が local_openai の時だけアダプタへ渡す (hosted は無視)。 */
  enableThinking?: boolean;
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
  // 出力上限は per-model の entry.maxTokens (#206 §8.10)。呼び側が指定すればその値、
  // 未指定ならモデルの上限をフル使用。いずれも entry.maxTokens でキャップ。
  const requested = opts.maxTokens ?? entry.maxTokens;
  const maxTokens = Math.min(requested, entry.maxTokens);
  const hasTools = !!opts.tools && opts.tools.length > 0;

  if (entry.provider === "anthropic") {
    const apiKey = await keyForProvider("anthropic");
    if (!apiKey) throw new Error("anthropic API key 未設定");
    const client = new Anthropic({ apiKey });
    return client.messages.create({
      model: entry.modelId,
      max_tokens: maxTokens,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
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
      temperature: opts.temperature,
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
    temperature: opts.temperature,
    // reasoning model の 2000 floor が entry.maxTokens を超えないよう ceiling を渡す (#206 §8.10)
    maxTokensCeiling: entry.maxTokens,
    // thinking 制御 (#206 §8.9) はローカル self-host (Gemma/Qwen) のみに送る
    // (hosted の openai/grok に chat_template_kwargs を送ると 400 になりうる)。
    enableThinking: entry.provider === "local_openai" ? opts.enableThinking : undefined,
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
      enableThinking: false, // probe は抑制で高速 (§8.8)
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

  // ② tool-use probe (echo を強制 → tool_use ブロックが返れば対応)。
  //   戻り値: true=tool_use 有り / false=2xx だが tool_use 無し / null=例外 (4xx 等)
  let probeErr: unknown = null;
  const probeOnce = async (enableThinking: boolean): Promise<boolean | null> => {
    try {
      const res = await callModelDirect(entry, {
        messages: [{ role: "user", content: "Use the echo tool to echo the word: hello" }],
        tools: [PROBE_TOOL],
        toolChoice: { name: "echo" },
        maxTokens: 128,
        enableThinking,
      });
      return res.content.some((b) => b.type === "tool_use");
    } catch (e) {
      probeErr = e;
      console.warn(
        `[model-test] ${entry.label} tool probe (thinking=${enableThinking}) failed:`,
        e instanceof Error ? e.message : e
      );
      return null;
    }
  };

  const first = await probeOnce(false);
  if (first === true) {
    cap.supportsTools = true;
  } else if (first === false && entry.provider === "local_openai") {
    // 2xx だが tool_use 無し + local → 推論モデルが思考しないと tool を返さない可能性。
    // thinking ON で 1 回だけ再 probe (§8.8.3、GPT-OSS 等の false negative 回避)。
    const second = await probeOnce(true);
    if (second === true) {
      cap.supportsTools = true;
      cap.toolUseRequiresThinking = true;
      cap.lastError = null; // クリーンな成功 (UI で「成功だがエラー」に見せない)
      console.info(`[model-test] ${entry.label}: tool は thinking ON でのみ対応 (toolUseRequiresThinking)`);
    } else {
      cap.supportsTools = false;
      cap.lastError =
        second === null ? `tool 非対応 (${categorizeErr(probeErr)})` : "tool_use 応答なし (thinking ON でも不成立)";
    }
  } else if (first === false) {
    // hosted で 2xx だが tool_use 無し (再 probe しない)
    cap.supportsTools = false;
    cap.lastError = "tool_use 応答なし (= 非対応の可能性)";
  } else {
    // first === null: 例外 (4xx 等)。tools を受け付けない endpoint 等 → 非対応扱い。
    cap.supportsTools = false;
    cap.lastError = `tool 非対応 (${categorizeErr(probeErr)})`;
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
