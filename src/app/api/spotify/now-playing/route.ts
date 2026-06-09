/**
 * GET /api/spotify/now-playing
 *
 * 再生中のトラックを取得。未再生時は null。
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  getNowPlaying,
  isSpotifyNotConnectedError,
  isSpotifyPremiumRequiredError,
} from "@/lib/spotify";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const np = await getNowPlaying();
    return NextResponse.json({ nowPlaying: np });
  } catch (e) {
    if (isSpotifyNotConnectedError(e)) {
      return NextResponse.json(
        { error: "Spotify not connected" },
        { status: 401 }
      );
    }
    if (isSpotifyPremiumRequiredError(e)) {
      return NextResponse.json(
        { error: "Spotify Premium required" },
        { status: 402 }
      );
    }
    return clientError(req, e, {
      context: "spotify/now-playing",
      message: "再生中の曲情報取得に失敗しました",
    });
  }
}
