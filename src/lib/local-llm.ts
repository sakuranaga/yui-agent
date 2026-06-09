/**
 * OpenAI 互換エンドポイント (ローカル Gemma 等) の薄いラッパー。
 *
 * `callLlm` (Anthropic) と同じ呼び出し形・戻り値形に合わせて、上位コード
 * (extract / reconcile / curate 等) を 1 箇所のディスパッチで切り替えられるようにする。
 *
 * 設計: docs/ai-settings.md / docs/mail-system.md §5
 */
import Anthropic from "@anthropic-ai/sdk";
import { getLocalLlmConfig } from "@/lib/ai-settings";

const MAX_RETRIES = 2;

type OpenAIResponse = {
  id?: string;
  model?: string;
  choices?: Array<{
    finish_reason?: string;
    message?: { role?: string; content?: string };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
};

export type CallLocalLlmOpts = {
  system?: string;
  messages: Array<{ role: "user" | "assistant"; content: string }>;
  maxTokens?: number;
  temperature?: number;
  /** デバッグ用 (ログ表示) */
  roleLabel?: string;
};

/**
 * Anthropic.Message と同じ形状を組み立てて返す。caller は既存の
 * `response.content.filter((b) => b.type === "text").map(b => b.text)` パターンを
 * そのまま使える。
 */
export async function callLocalLlm(opts: CallLocalLlmOpts): Promise<Anthropic.Message> {
  const cfg = await getLocalLlmConfig();
  if (!cfg.enabled) {
    throw new Error("Local LLM is disabled in AI settings");
  }
  const t0 = Date.now();

  // OpenAI 形式の messages を作る (system は先頭に 1 件挿入)
  const messages: Array<{ role: string; content: string }> = [];
  if (opts.system) messages.push({ role: "system", content: opts.system });
  for (const m of opts.messages) messages.push({ role: m.role, content: m.content });

  const body = {
    model: cfg.model,
    messages,
    max_tokens: opts.maxTokens ?? 1024,
    // Gemma 3+ / Qwen 3+ 等の thinking モデルは default で内部考察を reasoning_content に
    // 流し、最終 content が空のまま max_tokens 切れになる事故が起きる。sub-model 用途は
    // JSON 即答が前提なので thinking を抑制する。
    // - llama.cpp / vLLM はこのフィールドを認識して chat template に渡す
    // - 非対応 server (Ollama / LM Studio 等) は未知フィールドとして無視 (= 影響なし)
    // - 非 thinking モデル (Llama / Qwen 2.5 / Mistral) ではそもそも該当 template が無いので no-op
    chat_template_kwargs: { enable_thinking: false },
    ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
  };

  let lastErr: unknown;
  let attempt = 0;
  while (attempt <= MAX_RETRIES) {
    try {
      // SSRF 防護: cfg.url は user 設定 (= AI 設定タブ) なので safeFetch 経由。
      // 内部 IP / Tailnet 等の私的 LLM を許可するには env SAFE_FETCH_ALLOWED_HOSTS に
      // 信頼ホスト名 (例: "ollama-host,llm.internal") を comma 区切りで登録する。
      const { safeFetch } = await import("@/lib/safe-fetch");
      const res = await safeFetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 120_000,
      });
      if (!res.ok) {
        // upstream の生 response body は exfil 経路になるので返さない
        throw new Error(`HTTP ${res.status}`);
      }
      const data = (await res.json()) as OpenAIResponse;
      const choice = data.choices?.[0];
      // chat_template_kwargs.enable_thinking: false が server 側で無視されたケースの
      // 防御: content が空でも reasoning_content に出力があれば fall-back で拾う。
      // 完全 strict な OpenAI 互換 server で reasoning_content フィールドが無くても害なし。
      const reasoning = (choice?.message as { reasoning_content?: string } | undefined)
        ?.reasoning_content;
      const text = choice?.message?.content || reasoning || "";
      const inT = data.usage?.prompt_tokens ?? 0;
      const outT = data.usage?.completion_tokens ?? 0;
      const dur = Date.now() - t0;

      const label = opts.roleLabel ?? "local";
      console.log(
        `[local-llm:${label}] model=${cfg.model} in=${inT} out=${outT} ${dur}ms${
          attempt > 0 ? ` retries=${attempt}` : ""
        }`
      );

      // Anthropic.Message 形状で返す (caller 互換)
      return {
        id: data.id ?? `local-${Date.now()}`,
        type: "message",
        role: "assistant",
        model: cfg.model,
        stop_reason: (choice?.finish_reason ?? "end_turn") as Anthropic.Message["stop_reason"],
        stop_sequence: null,
        content: [{ type: "text", text, citations: null }],
        usage: {
          input_tokens: inT,
          output_tokens: outT,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        } as Anthropic.Message["usage"],
      } as Anthropic.Message;
    } catch (e) {
      lastErr = e;
      attempt++;
      if (attempt > MAX_RETRIES) break;
      const backoff = 500 * Math.pow(2, attempt - 1);
      console.warn(
        `[local-llm:${opts.roleLabel ?? "local"}] retry in ${backoff}ms after: ${
          e instanceof Error ? e.message : String(e)
        }`
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw lastErr ?? new Error("callLocalLlm: exhausted retries");
}
