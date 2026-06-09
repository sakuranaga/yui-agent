/**
 * GET /api/spotify/devices
 *
 * Spotify Connect で利用可能なデバイス一覧。
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  getDevices,
  isSpotifyNotConnectedError,
  isSpotifyPremiumRequiredError,
} from "@/lib/spotify";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const devices = await getDevices();
    return NextResponse.json({ devices });
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
      context: "spotify/devices",
      message: "デバイス一覧の取得に失敗しました",
    });
  }
}
