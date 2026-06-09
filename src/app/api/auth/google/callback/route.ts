/**
 * GET /api/auth/google/callback?code=...&state=...
 *
 * Google から戻ってきた code を refresh_token に交換 → DB 保存。
 *
 * - 通常フロー (popup 無し): /settings に redirect (フラッシュメッセージ付き)
 * - popup フロー (cookie yui_oauth_popup=1 が立ってる): HTML 返して
 *   親 window に postMessage → window.close()
 */
import { NextResponse, type NextRequest } from "next/server";
import { completeAuthorization } from "@/lib/google-oauth";

const STATE_COOKIE = "yui_oauth_state";
const POPUP_COOKIE = "yui_oauth_popup";

export async function GET(req: NextRequest) {
  const isPopup = req.cookies.get(POPUP_COOKIE)?.value === "1";

  const error = req.nextUrl.searchParams.get("error");
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const stored = req.cookies.get(STATE_COOKIE)?.value;

  let resultEmail: string | null = null;
  let resultError: string | null = null;

  if (error) {
    // Google が返す error は OAuth 仕様の short token (access_denied 等)。
    // これは generic なのでそのまま表示しても情報漏洩にならない。
    resultError = `Google: ${error}`;
  } else if (!code || !state) {
    resultError = "callback: code/state missing";
  } else if (!stored || stored !== state) {
    resultError = "callback: state mismatch (CSRF guard)";
  } else {
    try {
      resultEmail = await completeAuthorization(code);
    } catch (e) {
      // 上流の生エラー (token endpoint の細かな失敗理由、ネットワーク詳細等) は
      // 再 redirect の query string に乗ると history / ブラウザ拡張 / proxy log に
      // 残るので、固定文に丸める。原因は server log で追う。
      console.error(
        "[google/callback] completeAuthorization failed:",
        e instanceof Error ? e.message : String(e)
      );
      resultError = "callback: authorization failed (see server log)";
    }
  }

  if (isPopup) {
    return clearCookiesOn(popupHtmlResponse(resultEmail, resultError));
  }

  // 通常フロー: /settings に redirect
  const settingsUrl = new URL("/settings", req.url);
  if (resultError) settingsUrl.searchParams.set("error", resultError);
  if (resultEmail) settingsUrl.searchParams.set("connected", resultEmail);
  return clearCookiesOn(NextResponse.redirect(settingsUrl));
}

function clearCookiesOn(res: NextResponse): NextResponse {
  res.cookies.delete(STATE_COOKIE);
  res.cookies.delete(POPUP_COOKIE);
  return res;
}

/**
 * popup window で開かれたページ。opener に postMessage して自閉する。
 */
function popupHtmlResponse(
  email: string | null,
  error: string | null
): NextResponse {
  const payload = email
    ? { type: "google-oauth-success", email }
    : { type: "google-oauth-error", error: error ?? "unknown" };
  const payloadJson = JSON.stringify(payload);
  const safeJson = payloadJson.replace(/</g, "\\u003c");

  const html = `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<title>Google 連携${email ? "完了" : "エラー"}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         background: #1a1d2e; color: #eaeaea; display: flex;
         align-items: center; justify-content: center; height: 100vh; margin: 0;
         padding: 20px; box-sizing: border-box; text-align: center; }
  .card { max-width: 420px; }
  .ok { color: #86efac; }
  .err { color: #fca5a5; }
  small { color: rgba(234,234,234,0.6); display: block; margin-top: 12px; }
</style>
</head>
<body>
  <div class="card">
    ${
      email
        ? `<h2 class="ok">連携が完了しました</h2><p>${escapeHtml(email)}</p>`
        : `<h2 class="err">連携に失敗しました</h2><p>${escapeHtml(error ?? "unknown")}</p>`
    }
    <small>このウィンドウは自動的に閉じます…</small>
  </div>
  <script>
    (function () {
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(${safeJson}, window.location.origin);
        }
      } catch (e) {
        console.warn("opener postMessage failed:", e);
      }
      setTimeout(function () { window.close(); }, 800);
    })();
  </script>
</body>
</html>`;
  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
