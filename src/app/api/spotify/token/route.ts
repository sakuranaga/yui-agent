/**
 * GET /api/spotify/token
 *
 * frontend Web Playback SDK 用に access_token を返す。
 * 単一ユーザ前提なので秘匿性は緩く、ご主人様自身のブラウザだけが取得する想定。
 * - 未連携なら 401
 * - 取得失敗 (= Premium block 等) は 502
 */
import { NextResponse, type NextRequest } from "next/server";
import { getAccessToken } from "@/lib/spotify";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const token = await getAccessToken();
    if (!token) {
      return NextResponse.json(
        { error: "Spotify not connected" },
        { status: 401 }
      );
    }
    return NextResponse.json({ access_token: token });
  } catch (e) {
    return clientError(req, e, {
      status: 502,
      message: "Spotify トークン取得に失敗しました",
      context: "spotify/token",
    });
  }
}
