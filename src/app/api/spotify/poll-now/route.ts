/**
 * POST /api/spotify/poll-now
 *
 * 即時 in-memory now-playing キャッシュを Spotify Web API から再取得する kick endpoint。
 * 主に Web Playback SDK の player_state_changed event (= 曲変化) から呼ばれて
 * 30s server poll を待たずに setNowPlaying → 曲変化 fire を走らせる。
 *
 * body 不要。失敗 (未連携 / token 切れ) は黙って 200 を返す
 * (= 呼び出し元 SDK は再試行責任を負わない)。
 */
import { NextResponse } from "next/server";
import { kickSpotifyPollNow } from "@/lib/music-commands";

export async function POST() {
  if (process.env.NODE_ENV !== "production") {
    console.log("[spotify/poll-now] kick received");
  }
  try {
    await kickSpotifyPollNow();
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[spotify/poll-now] failed:", e);
    }
  }
  return NextResponse.json({ ok: true });
}
