/**
 * 各 LLM provider の model 一覧を取得する fetcher 群。
 *
 * - 各 provider の公式 `/v1/models` 系エンドポイントを直叩き
 * - Valkey に 1h TTL で cache (provider 別 key)。API キーが変わったら invalidate
 * - 失敗 (キー無効 / ネットワーク不通) は安全側 = 空配列 + warning
 *
 * Phase 1: 取得 + マージ表示までで実 LLM 呼び出し router は未実装。Phase 2 で
 * 選択された model ID をもとに該当 provider の SDK を呼び出す。
 *
 * 設計: docs/roadmap.md §6.10 (multi-provider AI)
 */
import { cacheGet, cacheSet, cacheDel } from "@/lib/cache";

export type ProviderId = "anthropic" | "openai" | "gemini" | "grok";

export type LlmModel = {
  id: string;          // 各 provider の native ID (例 "claude-sonnet-4-6", "gpt-5", "gemini-2.5-pro", "grok-3")
  provider: ProviderId;
  label: string;       // UI 表示名 (基本 id と同じだが、display_name があれば併記)
};

const CACHE_TTL_SEC = 60 * 60; // 1 時間

function cacheKey(provider: ProviderId): string {
  return `llm-models:${provider}`;
}

// ───── Anthropic ─────
async function fetchAnthropicModels(apiKey: string): Promise<LlmModel[]> {
  // eslint-disable-next-line no-restricted-syntax -- Anthropic 公式 API endpoint 固定
  const res = await fetch("https://api.anthropic.com/v1/models", {
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`anthropic /v1/models ${res.status}`);
  }
  const json = (await res.json()) as {
    data: Array<{ id: string; display_name?: string; type?: string }>;
  };
  return (json.data ?? []).map((m) => ({
    id: m.id,
    provider: "anthropic",
    label: m.display_name && m.display_name !== m.id ? `${m.id} (${m.display_name})` : m.id,
  }));
}

// ───── OpenAI ─────
async function fetchOpenAIModels(apiKey: string): Promise<LlmModel[]> {
  // eslint-disable-next-line no-restricted-syntax -- OpenAI 公式 API endpoint 固定
  const res = await fetch("https://api.openai.com/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`openai /v1/models ${res.status}`);
  }
  const json = (await res.json()) as {
    data: Array<{ id: string; owned_by?: string }>;
  };
  // chat-completion 系の model を中心に拾う (embedding / tts / image は除外)
  const include = (id: string) =>
    id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4") || id.startsWith("chatgpt-");
  return (json.data ?? [])
    .filter((m) => include(m.id))
    .map((m) => ({ id: m.id, provider: "openai", label: m.id }));
}

// ───── Gemini ─────
async function fetchGeminiModels(apiKey: string): Promise<LlmModel[]> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  // eslint-disable-next-line no-restricted-syntax -- Gemini 公式 API endpoint 固定
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    throw new Error(`gemini models ${res.status}`);
  }
  const json = (await res.json()) as {
    models: Array<{
      name: string; // "models/gemini-2.5-pro"
      displayName?: string;
      supportedGenerationMethods?: string[];
    }>;
  };
  return (json.models ?? [])
    .filter((m) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
    .filter((m) => m.name.startsWith("models/gemini-"))
    .map((m) => {
      const id = m.name.replace(/^models\//, "");
      return {
        id,
        provider: "gemini" as const,
        label:
          m.displayName && m.displayName !== id ? `${id} (${m.displayName})` : id,
      };
    });
}

// ───── Grok (xAI) ─────
async function fetchGrokModels(apiKey: string): Promise<LlmModel[]> {
  // eslint-disable-next-line no-restricted-syntax -- xAI 公式 API endpoint 固定
  const res = await fetch("https://api.x.ai/v1/models", {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    throw new Error(`xai /v1/models ${res.status}`);
  }
  const json = (await res.json()) as {
    data: Array<{ id: string; owned_by?: string }>;
  };
  return (json.data ?? [])
    .filter((m) => m.id.startsWith("grok-"))
    .map((m) => ({ id: m.id, provider: "grok", label: m.id }));
}

// ───── public ─────

export async function listModelsForProvider(
  provider: ProviderId,
  apiKey: string | null
): Promise<LlmModel[]> {
  if (!apiKey) return [];
  // Cache hit?
  const hit = await cacheGet<LlmModel[]>(cacheKey(provider));
  if (hit) return hit;

  try {
    let models: LlmModel[];
    switch (provider) {
      case "anthropic":
        models = await fetchAnthropicModels(apiKey);
        break;
      case "openai":
        models = await fetchOpenAIModels(apiKey);
        break;
      case "gemini":
        models = await fetchGeminiModels(apiKey);
        break;
      case "grok":
        models = await fetchGrokModels(apiKey);
        break;
    }
    await cacheSet(cacheKey(provider), models, CACHE_TTL_SEC);
    return models;
  } catch (e) {
    console.warn(`[llm-models] ${provider} fetch failed:`, e instanceof Error ? e.message : e);
    return [];
  }
}

export async function invalidateModelsCache(provider?: ProviderId): Promise<void> {
  if (provider) {
    await cacheDel(cacheKey(provider));
  } else {
    await cacheDel(
      ...(["anthropic", "openai", "gemini", "grok"] as ProviderId[]).map(cacheKey)
    );
  }
}

/**
 * 全 provider の API キーから model list を一気に取得 (並列)。
 * キー未設定 provider は空配列なのでスキップされる。
 */
export async function listAllAvailableModels(keys: {
  anthropic: string | null;
  openai: string | null;
  gemini: string | null;
  grok: string | null;
}): Promise<LlmModel[]> {
  const [a, o, g, x] = await Promise.all([
    listModelsForProvider("anthropic", keys.anthropic),
    listModelsForProvider("openai", keys.openai),
    listModelsForProvider("gemini", keys.gemini),
    listModelsForProvider("grok", keys.grok),
  ]);
  return [...a, ...o, ...g, ...x];
}
