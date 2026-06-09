/**
 * GET /api/spotify/callback?code=...&state=...
 *
 * Spotify から戻ってきた code を refresh_token に交換 → DB 保存。
 * state を cookie と照合して CSRF をブロック。完了後は /settings に redirect。
 *
 * 注意: Spotify は localhost を redirect URI に許容しないため、ここで踏むのは
 * 必ず http://127.0.0.1:3000/api/spotify/callback。
 */
import { NextResponse, type NextRequest } from "next/server";
import { completeAuthorization } from "@/lib/spotify";

const STATE_COOKIE = "yui_spotify_oauth_state";

export async function GET(req: NextRequest) {
  const error = req.nextUrl.searchParams.get("error");
  const code = req.nextUrl.searchParams.get("code");
  const state = req.nextUrl.searchParams.get("state");
  const stored = req.cookies.get(STATE_COOKIE)?.value;

  let resultOk = false;
  let resultError: string | null = null;

  if (error) {
    // Spotify が返す error は OAuth 仕様の short token。generic 表示で OK。
    resultError = `Spotify: ${error}`;
  } else if (!code || !state) {
    resultError = "callback: code/state missing";
  } else if (!stored || stored !== state) {
    resultError = "callback: state mismatch (CSRF guard)";
  } else {
    try {
      await completeAuthorization(code);
      resultOk = true;
    } catch (e) {
      // 上流の生エラーは history / log / 拡張機能に残るので redirect query には乗せない。
      console.error(
        "[spotify/callback] completeAuthorization failed:",
        e instanceof Error ? e.message : String(e)
      );
      resultError = "callback: authorization failed (see server log)";
    }
  }

  // Home に戻して SettingsModal を auto-open させる (= /settings 全画面ページは使わない)
  // 注意: Next.js dev server は req.url に listening address (= 0.0.0.0:3000) を入れてくる
  // ので、`new URL("/", req.url)` を使うと redirect 先が 0.0.0.0 になり「保護されてない
  // 通信」警告が出る。Host header から組み立てる。
  const host = req.headers.get("host") ?? "127.0.0.1:3000";
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (req.url.startsWith("https") ? "https" : "http");
  const homeUrl = new URL(`${proto}://${host}/`);
  if (resultError) homeUrl.searchParams.set("spotify_error", resultError);
  if (resultOk) homeUrl.searchParams.set("spotify_connected", "1");
  const res = NextResponse.redirect(homeUrl);
  res.cookies.delete(STATE_COOKIE);
  return res;
}
