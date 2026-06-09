import { applyDictionary } from "@/lib/tts-dictionary";
import { getTtsUrl } from "@/lib/ai-settings";

// 1 リクエストあたりのテキスト長上限。これ以上は upstream TTS を不要に長く占有して
// 増幅 DoS (= 認証突破した攻撃者がループで送る) の踏み台になる。
// 通常チャット応答は数十〜数百字、長くて 1-2 千字程度を想定。
const MAX_TTS_TEXT_LEN = 3_000;

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  if (body && typeof body === "object" && "text" in body) {
    const t = (body as { text?: unknown }).text;
    if (typeof t === "string" && t.length > MAX_TTS_TEXT_LEN) {
      return new Response(
        JSON.stringify({ error: `text too long (${t.length} > ${MAX_TTS_TEXT_LEN})` }),
        { status: 413, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  // 用語辞書を pre-apply (longest-first 単純置換)。チャット応答 / Apple Music
  // 曲紹介 / ハート反応 / 日記読み上げ、すべての TTS 経路に自動適用される。
  // 数十語 × 数百文字なら ~1ms、TTS 本体 (秒オーダ) に対して誤差。
  //
  // skipDictionary=true (読み方タブのテスト用) のときは辞書バイパスして生テキスト
  // のまま upstream へ送り、正規化なしの読み上げを試聴できる。
  if (body && typeof body === "object" && "text" in body) {
    const skipDict =
      "skipDictionary" in body && (body as { skipDictionary?: unknown }).skipDictionary === true;
    const raw = (body as { text?: unknown }).text;
    if (!skipDict && typeof raw === "string" && raw.length > 0) {
      const replaced = await applyDictionary(raw);
      (body as { text: string }).text = replaced;
    }
    // upstream には flag を渡さない (TTS server が知らないキーで落ちないように)
    if (skipDict) {
      delete (body as { skipDictionary?: boolean }).skipDictionary;
    }
  }

  const ttsUrl = await getTtsUrl();
  if (!ttsUrl) {
    // TTS 未設定 = 音声合成スキップ。frontend は !res.ok で null 戻り扱い (= 音声なしで会話続行)
    return new Response(
      JSON.stringify({ error: "tts not configured", disabled: true }),
      { status: 503, headers: { "Content-Type": "application/json" } }
    );
  }

  // 並列リクエストで TTS server が時々 5xx 返すので、最大 2 回までリトライ
  // (各リトライ間に 400ms / 800ms 待つ)。
  const MAX_RETRY = 2;
  let lastErr: { kind: "status" | "fetch"; status?: number; body?: string; msg?: string } | null =
    null;
  for (let attempt = 0; attempt <= MAX_RETRY; attempt++) {
    if (attempt > 0) {
      const waitMs = 400 * attempt;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      // SSRF 防護: ttsUrl は user 設定 (= AI 設定タブ) なので safeFetch 経由。
      // 内部 IP / Tailnet 上の TTS server を許可するには env SAFE_FETCH_ALLOWED_HOSTS で
      // 明示登録する流儀 (= user 入力 hostname の自動 allowlist 化は SSRF 防護無効化)。
      const { safeFetch } = await import("@/lib/safe-fetch");
      const upstream = await safeFetch(`${ttsUrl}/tts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        timeoutMs: 60_000,
        // TTS の音声 wav は MB オーダになるので緩めに
        maxBytes: 50 * 1024 * 1024,
      });
      if (upstream.ok) {
        return new Response(upstream.body, {
          status: 200,
          headers: {
            "Content-Type": upstream.headers.get("Content-Type") ?? "audio/wav",
            "Cache-Control": "no-store",
          },
        });
      }
      // 5xx はリトライ、4xx は即返却 (リクエスト不正なのでリトライしても無駄)
      const text = await upstream.text().catch(() => "");
      lastErr = { kind: "status", status: upstream.status, body: text };
      if (upstream.status < 500) break;
    } catch (e) {
      // ネットワーク / timeout / DNS 失敗 (ENOTFOUND 等) はリトライ
      const msg = e instanceof Error ? e.message : String(e);
      const name = e instanceof Error ? e.name : "";
      const cause =
        e instanceof Error && "cause" in e
          ? String((e as { cause?: unknown }).cause)
          : undefined;
      console.error(`[tts] upstream fetch failed (attempt ${attempt + 1}):`, {
        name,
        msg,
        cause,
        url: ttsUrl,
      });
      lastErr = { kind: "fetch", msg };
    }
  }

  // client には generic error + status code (upstream) のみ。
  // upstream body / e.message は console.error で既に server log に出ているので、
  // ここで再度 client に出さない (= 上流 GPU サーバの内部メッセージ漏洩防止)。
  const errorKind = lastErr?.kind === "status" ? "tts upstream error" : "tts fetch failed";
  const upstreamStatus = lastErr?.kind === "status" ? lastErr.status : undefined;
  return new Response(
    JSON.stringify({
      error: errorKind,
      ...(upstreamStatus !== undefined ? { upstreamStatus } : {}),
      retries: MAX_RETRY,
    }),
    { status: 502, headers: { "Content-Type": "application/json" } }
  );
}
