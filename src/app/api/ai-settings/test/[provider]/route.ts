/**
 * POST /api/ai-settings/test/<provider>
 *   接続テスト。provider = anthropic | local | tts | embed
 *   body に test 用の上書き値を渡せる (保存前のテストで使う)。
 *
 * 設計: docs/ai-settings.md §6
 */
import { NextResponse, type NextRequest } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  getAnthropicConfig,
  getLocalLlmConfig,
  getTtsUrl,
  getEmbedConfig,
} from "@/lib/ai-settings";

export const dynamic = "force-dynamic";

type Provider = "anthropic" | "local" | "tts" | "embed";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ provider: string }> }
) {
  const { provider } = await params;
  if (!isProvider(provider)) {
    return NextResponse.json({ error: "unknown provider" }, { status: 400 });
  }
  const override = (await req.json().catch(() => ({}))) as Record<string, string>;

  const t0 = Date.now();
  try {
    switch (provider) {
      case "anthropic":
        await testAnthropic(override);
        break;
      case "local":
        await testLocal(override);
        break;
      case "tts":
        await testTts(override);
        break;
      case "embed":
        await testEmbed(override);
        break;
    }
    return NextResponse.json({ ok: true, latencyMs: Date.now() - t0 });
  } catch (e) {
    // テスト経路は user が原因を知りたい場面なので、最小限 (= HTTP status / timeout / invalid URL)
    // だけは UI に出す。それ以上の詳細 (= upstream body / stack) は server log のみ。
    const raw = e instanceof Error ? e.message : String(e);
    const safe = sanitizeTestError(raw);
    console.warn(`[ai-settings/test/${provider}] failed: ${raw}`);
    return NextResponse.json(
      { ok: false, error: safe, latencyMs: Date.now() - t0 },
      { status: 200 } // テストエラーは 200 で ok=false を返す (UI 側で扱う)
    );
  }
}

/** 上流 error から「HTTP <status>」「timeout」等の安全な構造化 message だけ抽出 */
function sanitizeTestError(msg: string): string {
  const httpMatch = msg.match(/HTTP\s+(\d{3})/);
  if (httpMatch) return `HTTP ${httpMatch[1]}`;
  if (/timeout|aborted/i.test(msg)) return "timeout";
  if (/invalid URL/i.test(msg)) return "invalid URL";
  if (/blocked/i.test(msg)) return "URL refused (private/loopback)";
  if (/ENOTFOUND|EAI_AGAIN/i.test(msg)) return "DNS resolution failed";
  if (/ECONNREFUSED/i.test(msg)) return "connection refused";
  return "test failed (詳細は server log)";
}

function isProvider(p: string): p is Provider {
  return p === "anthropic" || p === "local" || p === "tts" || p === "embed";
}

async function testAnthropic(override: Record<string, string>): Promise<void> {
  const cfg = await getAnthropicConfig();
  const apiKey = override.anthropic_api_key && !override.anthropic_api_key.includes("***")
    ? override.anthropic_api_key
    : cfg.apiKey;
  if (!apiKey) throw new Error("API key 未設定");
  const model = override.anthropic_haiku_model || cfg.haikuModel;
  const client = new Anthropic({ apiKey });
  await client.messages.create({
    model,
    max_tokens: 16,
    messages: [{ role: "user", content: "ping" }],
  });
}

async function testLocal(override: Record<string, string>): Promise<void> {
  const cfg = await getLocalLlmConfig();
  const url = override.local_llm_url || cfg.url;
  const model = override.local_llm_model || cfg.model;
  // SSRF 防護: ユーザがフォームで入力する任意 URL なので safeFetch 経由。
  // 内部 IP / Tailnet 等を許可したい場合は env SAFE_FETCH_ALLOWED_HOSTS に
  // 信頼ホスト名を明示登録する (= user 入力 hostname を自動 allowlist にすると
  // SSRF 防護無効化になるため、caller では allowedHosts を渡さない)。
  const { safeFetch } = await import("@/lib/safe-fetch");
  let res: Response;
  try {
    res = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 16,
        // Gemma 3+ / Qwen 3+ の thinking モデルは default ON だと 16 token 枠を内部考察で
        // 使い切って content 空 → 「応答に content が無い」で接続テスト失敗。詳細は local-llm.ts。
        chat_template_kwargs: { enable_thinking: false },
      }),
      timeoutMs: 15_000,
    });
  } catch (e) {
    throw new Error(e instanceof Error ? e.message : String(e));
  }
  if (!res.ok) {
    // upstream の生 response body は exfil 経路になるので返さない (= 旧: 200 字 reflect)
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; reasoning_content?: string } }>;
  };
  // chat_template_kwargs が無視された場合の fall-back として reasoning_content も許容
  const msg = data.choices?.[0]?.message;
  if (!msg?.content && !msg?.reasoning_content) {
    throw new Error("応答に content が無い");
  }
}

async function testTts(override: Record<string, string>): Promise<void> {
  const baseUrl = override.tts_url || (await getTtsUrl());
  if (!baseUrl) {
    throw new Error("TTS URL が未設定です。設定 → AI で TTS URL を入力してください (空欄 = TTS 無効)");
  }
  const base = baseUrl.replace(/\/$/, "");
  // TTS サーバーは voicevox / aivisspeech / 独自実装で endpoint がバラバラ。
  // 候補を順に試して、どれか 1 つでも到達 (200-499) を返したら「死活 ok」とみなす。
  // SSRF 防護: ユーザ入力 URL なので safeFetch 経由 (= 内部 IP 許可は env
  // SAFE_FETCH_ALLOWED_HOSTS で明示登録)。
  const { safeFetch } = await import("@/lib/safe-fetch");
  const candidates = ["/version", "/speakers", "/", "/openapi.json"];
  let lastErr: string | null = null;
  for (const path of candidates) {
    try {
      const res = await safeFetch(base + path, {
        method: "GET",
        timeoutMs: 5_000,
      });
      if (res.status < 500) {
        return; // 接続できた = ok
      }
      lastErr = `HTTP ${res.status} on ${path}`;
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  throw new Error(lastErr ?? "no candidate endpoint reachable");
}

async function testEmbed(override: Record<string, string>): Promise<void> {
  const cfg = await getEmbedConfig();
  const url = override.embed_url || cfg.url;
  const model = override.embed_model || cfg.model;
  // SSRF 防護: user 入力 URL なので safeFetch 経由 (= 内部 IP 許可は env
  // SAFE_FETCH_ALLOWED_HOSTS で明示登録すること)
  const { safeFetch } = await import("@/lib/safe-fetch");
  const res = await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: "ping" }),
    timeoutMs: 15_000,
  });
  if (!res.ok) {
    // upstream response body は exfil 経路になるので返さない
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as { data?: Array<{ embedding?: number[] }> };
  const emb = data.data?.[0]?.embedding;
  if (!emb || !Array.isArray(emb) || emb.length === 0) {
    throw new Error("応答に embedding が無い");
  }
}
