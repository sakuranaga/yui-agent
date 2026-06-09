/**
 * GET /api/spotify/authorize
 *
 * Spotify 同意画面に redirect する。
 * - CSRF 対策: state を生成して cookie に置き、callback で照合
 * - client 未設定なら /settings にエラー付き redirect
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  buildAuthorizationUrl,
  isSpotifyClientConfigured,
} from "@/lib/spotify";

const STATE_COOKIE = "yui_spotify_oauth_state";

export async function GET(req: NextRequest) {
  if (!(await isSpotifyClientConfigured())) {
    const url = new URL("/settings", req.url);
    url.searchParams.set(
      "error",
      "Spotify client_id / client_secret が未設定です。設定 > 連携 で登録してください。"
    );
    return NextResponse.redirect(url);
  }

  const state = crypto.randomUUID();
  const authUrl = await buildAuthorizationUrl(state);
  const res = NextResponse.redirect(authUrl);
  res.cookies.set(STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 10 * 60, // 10 min
  });
  return res;
}
