/**
 * GET /api/spotify/search?q=...&type=track|playlist&limit=20
 *
 * track / playlist の検索。
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  isSpotifyNotConnectedError,
  isSpotifyPremiumRequiredError,
  searchPlaylists,
  searchTracks,
} from "@/lib/spotify";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q");
  const typeParam = req.nextUrl.searchParams.get("type") ?? "track";
  const limitParam = req.nextUrl.searchParams.get("limit");

  if (!q || q.trim().length === 0) {
    return NextResponse.json({ error: "q is required" }, { status: 400 });
  }
  if (typeParam !== "track" && typeParam !== "playlist") {
    return NextResponse.json(
      { error: "type must be track or playlist" },
      { status: 400 }
    );
  }

  let limit = 20;
  if (limitParam !== null) {
    const parsed = Number.parseInt(limitParam, 10);
    if (Number.isNaN(parsed)) {
      return NextResponse.json(
        { error: "limit must be integer" },
        { status: 400 }
      );
    }
    limit = parsed;
  }

  try {
    if (typeParam === "track") {
      const tracks = await searchTracks(q, limit);
      return NextResponse.json({ type: "track", results: tracks });
    }
    const playlists = await searchPlaylists(q, limit);
    return NextResponse.json({ type: "playlist", results: playlists });
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
      context: "spotify/search",
      message: "Spotify 検索に失敗しました",
    });
  }
}
