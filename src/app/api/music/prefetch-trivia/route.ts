/**
 * POST /api/music/prefetch-trivia
 *
 * Body: { title: string, artist?: string, trackUri?: string }
 *
 * 用途:
 *   Web Playback SDK の player_state_changed event で track_window.next_tracks[0]
 *   が判明したタイミングでブラウザから kick される「先読み trivia キャッシュ」endpoint。
 *   実際に次曲に切り替わる前にキャッシュを温めておくことで、specialist の
 *   spotify_search_play や曲変化通知の trivia fetch がゼロ待ちで返る。
 *
 * cache hit / fetch 失敗 含めて、常に 200 + { ok: true, cached?: boolean }。
 * 呼出元 (SDK listener) は結果を見ない (= fire-and-forget)。
 */
import { NextResponse, type NextRequest } from "next/server";
import { enqueueBackgroundJob } from "@/lib/jobs/background";

export async function POST(req: NextRequest) {
  let body: { title?: string; artist?: string; trackUri?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const title = typeof body.title === "string" ? body.title : "";
  if (!title.trim()) {
    return NextResponse.json({ error: "title required" }, { status: 400 });
  }
  const artist = typeof body.artist === "string" ? body.artist : null;
  const trackUri = typeof body.trackUri === "string" ? body.trackUri : null;

  try {
    await enqueueBackgroundJob({
      jobType: "music.prefetch_trivia",
      payload: { title, artist, trackUri },
      dedupKey: `music.prefetch_trivia:${trackUri ?? `${title}:${artist ?? ""}`}`,
      priority: 140,
    });
  } catch (e) {
    if (process.env.NODE_ENV !== "production") {
      console.warn("[prefetch-trivia] enqueue failed:", e instanceof Error ? e.message : e);
    }
  }

  return NextResponse.json({ ok: true });
}
