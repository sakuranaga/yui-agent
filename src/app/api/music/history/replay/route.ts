/**
 * POST /api/music/history/replay
 *
 * Body (どちらか):
 *   { mode: "song", song_id, title?, artist?, sessionId }
 *     → 曲名 + アーティスト名で Spotify を再検索 → 再生
 *   { mode: "container", container_kind: "playlist"|"album", container_id, container_name?, sessionId }
 *     → playlist/album 名で Spotify を再検索 → 再生
 *
 * Apple Music 時代の song_id / playlist_id は Spotify と互換ではないので、
 * 名前ベースで再検索する。完全一致しないこともある (= 別バージョン / 別カバー) が、
 * OSS 配布の都合上ここは妥協。
 */
import { NextResponse, type NextRequest } from "next/server";
import { clientError } from "@/lib/api-error";

type Body =
  | {
      mode: "song";
      song_id: string;
      title?: string;
      artist?: string;
      sessionId: string;
    }
  | {
      mode: "container";
      container_kind: "playlist" | "album";
      container_id: string;
      container_name?: string;
      sessionId: string;
    };

export async function POST(req: NextRequest) {
  let body: Partial<Body>;
  try {
    body = (await req.json()) as Partial<Body>;
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  let prompt = "";
  if (body.mode === "song") {
    // Apple Music の song_id は Spotify と互換でないので、必ず title/artist で再検索する。
    if (!body.title) {
      return NextResponse.json(
        { error: "title required for song replay (id is no longer used)" },
        { status: 400 }
      );
    }
    const queryParts = [body.title, body.artist].filter(Boolean).join(" ");
    const label = body.artist
      ? `「${body.title}」 / ${body.artist}`
      : `「${body.title}」`;
    prompt = [
      `履歴から曲を再生する指示が来ました。Music specialist で以下を順に実行:`,
      `1) spotify_search_play(query="${queryParts}", kind="track") を呼ぶ (再生対象: ${label})`,
      `2) web_search で曲・アーティストの簡単な情報を 1-2 文取得`,
      `3) ご主人様に「${label}を再生開始しました。○○○○」のように、曲名・アーティスト・簡単な雑学を添えて報告`,
    ].join("\n");
  } else if (body.mode === "container" && body.container_kind) {
    const label = body.container_name ? `「${body.container_name}」` : "選択された出処";
    if (!body.container_name) {
      return NextResponse.json(
        { error: "container_name required for container replay (id is no longer used)" },
        { status: 400 }
      );
    }
    // playlist / album いずれも Spotify では playlist として名前検索する
    // (album も「アルバム名 アーティスト名」で playlist 検索すると album が引かれることが多いが、
    //  Yui の用途的には「同じ雰囲気の曲を流す」で十分なので playlist 推奨)
    const kind = body.container_kind === "album" ? "track" : "playlist";
    prompt = [
      `履歴から ${body.container_kind} を再生する指示が来ました。Music specialist で:`,
      `1) spotify_search_play(query="${body.container_name}", kind="${kind}") を呼ぶ (再生対象: ${label})`,
      `2) web_search で簡単な情報を取得`,
      `3) ご主人様に「${label}を再生開始しました。○○○○」のように報告`,
    ].join("\n");
  } else {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const port = process.env.PORT ?? "3000";
  try {
    const { internalFetch } = await import("@/lib/internal-fetch");
    const res = await internalFetch(`http://localhost:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        sessionId: body.sessionId,
        source: "cron",
      }),
    });
    if (!res.ok) {
      return NextResponse.json(
        { error: `chat call returned ${res.status}` },
        { status: 502 }
      );
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "music/history/replay", message: "履歴からの再生に失敗しました" });
  }
}
