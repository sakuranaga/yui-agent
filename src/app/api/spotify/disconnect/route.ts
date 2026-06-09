/**
 * POST /api/spotify/disconnect
 *
 * DB から token row を削除して連携解除。
 * Spotify 側に明示的な revoke API は無いので DB 削除のみ。
 * 完全に外したい場合は https://www.spotify.com/account/apps/ から手動で外す。
 */
import { NextResponse, type NextRequest } from "next/server";
import { disconnect } from "@/lib/spotify";
import { clientError } from "@/lib/api-error";

export async function POST(req: NextRequest) {
  try {
    await disconnect();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, {
      context: "spotify/disconnect",
      message: "Spotify 連携解除に失敗しました",
    });
  }
}
