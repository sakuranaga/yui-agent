/**
 * GET /api/auth/google/start
 *
 * Google OAuth 同意画面に redirect する。
 * - CSRF 対策: state を生成して cookie に置き、callback で照合
 * - 失敗時はエラーメッセージ付きで /settings に戻す
 */
import { NextResponse, type NextRequest } from "next/server";
import { randomBytes } from "node:crypto";
import { buildAuthorizationUrl, isGoogleClientConfigured } from "@/lib/google-oauth";

const STATE_COOKIE = "yui_oauth_state";
const POPUP_COOKIE = "yui_oauth_popup";

export async function GET(req: NextRequest) {
  const isPopup = req.nextUrl.searchParams.get("popup") === "1";

  if (!isGoogleClientConfigured()) {
    const url = new URL("/settings", absoluteOrigin());
    url.searchParams.set(
      "error",
      "GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI が .env に設定されていません。docs/google-oauth-setup.md を参照。"
    );
    return NextResponse.redirect(url);
  }
  const state = randomBytes(16).toString("hex");
  const authUrl = buildAuthorizationUrl(state);
  const res = NextResponse.redirect(authUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60, // 10 min
  });
  // popup フローかどうかを callback 側で判別するための marker
  if (isPopup) {
    res.cookies.set(POPUP_COOKIE, "1", {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 10 * 60,
    });
  } else {
    // 念のため過去の popup cookie を消す
    res.cookies.delete(POPUP_COOKIE);
  }
  return res;
}

// 開発時 .env に NEXT_PUBLIC_APP_ORIGIN が無くても動くようフォールバック
function absoluteOrigin(): string {
  return (
    process.env.NEXT_PUBLIC_APP_ORIGIN ??
    process.env.APP_ORIGIN ??
    "http://localhost:3000"
  );
}
