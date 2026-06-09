/**
 * GET /api/spotify/status
 *
 * Spotify 連携状況を返す。Settings UI / IconBar / MusicModal が読む。
 *
 * 区別:
 * - clientConfigured: client_id / client_secret が integration_settings に入ってる
 * - connected:        DB に refresh_token が保存されてる (= OAuth 通過済)
 * - apiWorking:       実際に /me を叩いて 200 が返る (= dev mode block / 期限切れ等を検知)
 * - product:          "free" | "premium" (apiWorking=true の時だけ意味あり)
 * - error:            API 失敗時の理由 (Premium block 等)
 *
 * 注意: Spotify Web API は 2024 以降、開発者本人のアプリが Development Mode の場合、
 * **アプリ owner が Spotify Premium でないと一切 API が叩けない**。test users に登録しても
 * 同じ。これ無料じゃ動かない仕様で、connected=true でも apiWorking=false になるパターン
 * の主要原因。
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { spotifyOauthTokens } from "@/db/schema";
import {
  getMe,
  isSpotifyClientConfigured,
  isSpotifyNotConnectedError,
  isSpotifyPremiumRequiredError,
} from "@/lib/spotify";

export async function GET() {
  const clientConfigured = await isSpotifyClientConfigured();

  const [row] = await db.select().from(spotifyOauthTokens).limit(1);
  if (!row) {
    return NextResponse.json({
      connected: false,
      clientConfigured,
      apiWorking: false,
    });
  }

  // token はある → API を試して動くか確認
  try {
    const me = await getMe();
    return NextResponse.json({
      connected: true,
      clientConfigured,
      apiWorking: true,
      me,
      product: me?.product,
      tokenExpiresAt: row.expiresAt?.toISOString() ?? null,
    });
  } catch (e) {
    // 連携は済んでるが API が叩けない (= Premium block / token expired 等)。
    // 既知エラーは固定コードに分類、未知 error は server log に出すだけで client には
    // 詳細を漏らさない (上流の生メッセージに billing 情報や内部 ID が混ざる可能性があるため)。
    let errorCode = "unknown";
    if (isSpotifyNotConnectedError(e)) errorCode = "not_connected";
    else if (isSpotifyPremiumRequiredError(e)) errorCode = "premium_required";
    if (errorCode === "unknown") {
      console.warn(
        "[spotify/status] /me 呼び出し失敗:",
        e instanceof Error ? e.message : String(e)
      );
    }
    return NextResponse.json({
      connected: true,
      clientConfigured,
      apiWorking: false,
      errorCode,
      tokenExpiresAt: row.expiresAt?.toISOString() ?? null,
    });
  }
}
