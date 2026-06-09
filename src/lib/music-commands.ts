/**
 * 「いま流れてる曲」のサーバ側キャッシュ + 再生履歴の永続化 + 曲変化通知。
 *
 * 更新パスは push + on-demand のみ (定期 polling 無し):
 *   - SDK push: SpotifyWebPlayer の player_state_changed → POST /api/spotify/poll-now
 *     → kickSpotifyPollNow() → setNowPlaying
 *   - ENV on-demand: environment.ts の safeNowPlaying() が cache stale (> 10s) なら
 *     kickSpotifyPollNow() を await してから ENV ブロックへ書き出し
 *
 * `setNowPlaying` 自体: track 変化を検知 → trackHistory に append →
 * music_track_history テーブルに永続化 → +0.5 XP。
 *
 * Yui は単一ユーザー想定なので global で十分。
 */

/**
 * 「いま実際に再生中の曲」の情報。
 * specialist が「この曲なに?」に答えるソース、かつ trackHistory への push source。
 * id は Spotify では track URI (例: spotify:track:...) を入れる。
 */
export type NowPlaying = {
  /** Apple Music song id */
  id?: string;
  title: string;
  artist?: string;
  album?: string;
  /** ms */
  durationMs?: number;
  /**
   * **実際に音が出ているか** (= Spotify の `is_playing`)。
   * 一時停止 (pause) 後も Spotify は track を保持して `is_playing:false` を返すので、
   * track 情報だけで「再生中」と判断すると ENV ブロックが嘘をつく。
   * 未指定 (= 旧データ / 不明) は true 扱いだが、新規 poll は必ず明示で入れる。
   */
  isPlaying?: boolean;
  /** 受信したサーバー時刻 (ms epoch) */
  updatedAt: number;
};

/**
 * 曲レベルの再生履歴 entry。
 * container_* は specialist が play_playlist / play_album で再生を起動した時の
 * 出処 (subsequent な自動切替トラックにも同じ container を紐付ける)。
 */
export type TrackContainerKind = "playlist" | "album" | "song";

export type TrackHistoryEntry = {
  timestamp: number;
  track: NowPlaying;
  containerKind?: TrackContainerKind;
  containerId?: string;
  containerName?: string;
};

/**
 * いまアクティブな再生コンテキスト (play_* 後、次の play_* まで保持)。
 * setNowPlaying で track を記録する時に attach する。
 */
declare global {
  var __vroidMusicContext:
    | { kind: TrackContainerKind; id: string; name?: string }
    | null
    | undefined;
}

declare global {
  var __vroidMusicNowPlaying: NowPlaying | null | undefined;
  var __vroidMusicTrackHistory: TrackHistoryEntry[] | undefined;
}

// 直近 "音楽の発話" (specialist が再生命令を出した、または曲変化通知を fire した) の時刻。
// 曲変化 auto-notify が specialist の初回応答と衝突するのを防ぐ rate-limit に使う。
declare global {
  var __vroidLastMusicNotifyAt: number | undefined;
  // 直近 play 系で「次の曲変化は cooldown を無視して紹介させる」フラグ。
  // 再生開始の voice formatter ("〜を再生します") と 1 曲目紹介はテーマが違うので
  // 続けて喋っても自然な流れになる。逆にここを抑えると永久に 1 曲目だけ紹介されない。
  var __vroidExpectFirstTrackIntro: boolean | undefined;
}
export function markMusicActivity(): void {
  globalThis.__vroidLastMusicNotifyAt = Date.now();
}
export function getLastMusicActivityAt(): number {
  return globalThis.__vroidLastMusicNotifyAt ?? 0;
}
export function armFirstTrackIntro(): void {
  globalThis.__vroidExpectFirstTrackIntro = true;
}
/** フラグを 1 回だけ消費する。true なら「今回はクールダウン無視」。 */
export function consumeFirstTrackIntro(): boolean {
  const v = globalThis.__vroidExpectFirstTrackIntro === true;
  if (v) globalThis.__vroidExpectFirstTrackIntro = false;
  return v;
}

const TRACK_HISTORY_MAX = 50;
const trackHistory: TrackHistoryEntry[] = globalThis.__vroidMusicTrackHistory ?? [];
if (globalThis.__vroidMusicTrackHistory === undefined) {
  globalThis.__vroidMusicTrackHistory = trackHistory;
}

/** in-process キャッシュとして残す (UI 即時表示用)。永続化は別途 DB に書く。 */
export function setNowPlaying(np: NowPlaying | null): void {
  if (np) {
    // prev === undefined は「server 起動後初の non-null 書き込み」(= globalThis が
    // まだ書かれていない)。container restart / Next dev HMR full reload / 本番デプロイ
    // 直後など、サーバ側 in-memory state がリセットされた直後にブラウザリロードで
    // SDK push が走ったときの「初登場扱い → 通知 fire」を避けるため baseline 扱いに。
    // null は specialist が「停止検知」で明示的に入れた値なので、その後 non-null は
    // 真の track 変化として扱う (= prev=null は引き続き notification fire)。
    const prev = globalThis.__vroidMusicNowPlaying;
    const isFirstAfterReset = prev === undefined;
    const isSame =
      !isFirstAfterReset &&
      prev != null &&
      ((np.id && prev.id === np.id) || prev.title === np.title);
    if (process.env.NODE_ENV !== "production") {
      console.log("[setNowPlaying]", {
        newTitle: np.title,
        newId: np.id,
        prevTitle: prev?.title,
        prevId: prev?.id,
        isFirstAfterReset,
        isSame,
      });
    }
    if (isFirstAfterReset) {
      // 通知も history append もせず、cache だけ立てて return
      globalThis.__vroidMusicNowPlaying = np;
      return;
    }
    if (!isSame) {
      const ctx = globalThis.__vroidMusicContext ?? null;
      const entry: TrackHistoryEntry = {
        timestamp: Date.now(),
        track: np,
        containerKind: ctx?.kind,
        containerId: ctx?.id,
        containerName: ctx?.name,
      };
      trackHistory.unshift(entry);
      if (trackHistory.length > TRACK_HISTORY_MAX) trackHistory.pop();
      // DB 永続化 (fire-and-forget、失敗しても再生体験は止めない)
      void persistTrackToDb(entry).catch((e) =>
        console.warn("[music-history] persist failed:", e)
      );
      // 曲変化を Yui に通知 (= 「次は X ですね」と短く声かけ + note panel 更新)
      // 直近の音楽操作 (= specialist の play 開始) から COOLDOWN_MS 以内なら抑制
      // (= specialist の初回紹介と二重発話するのを防ぐ)
      const sinceLastActivity = Date.now() - getLastMusicActivityAt();
      if (process.env.NODE_ENV !== "production") {
        console.log("[song-change] track changed", {
          title: np.title,
          sinceLastActivityMs: sinceLastActivity,
          cooldownMs: SONG_CHANGE_COOLDOWN_MS,
          willFire: sinceLastActivity > SONG_CHANGE_COOLDOWN_MS,
        });
      }
      if (sinceLastActivity > SONG_CHANGE_COOLDOWN_MS) {
        markMusicActivity();
        void notifyYuiSongChanged(np).catch((e) =>
          console.warn("[song-change] notify failed:", e)
        );
      }
    }
  }
  globalThis.__vroidMusicNowPlaying = np;
}

const SONG_CHANGE_COOLDOWN_MS = 30_000;

/** 直近 active session (= Web 側) を探して 「次は X ですね」prompt を内部 /api/chat に投げる */
async function notifyYuiSongChanged(np: NowPlaying): Promise<void> {
  // active session を探す
  const { db } = await import("@/db/client");
  const { rawMessages } = await import("@/db/schema");
  const { desc, ne, and } = await import("drizzle-orm");
  const botSid = process.env.DISCORD_SESSION_ID;
  const conds = botSid ? [ne(rawMessages.sessionId, botSid)] : [];
  const [row] = await db
    .select({ sessionId: rawMessages.sessionId })
    .from(rawMessages)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(rawMessages.createdAt))
    .limit(1);
  const sessionId = row?.sessionId;
  if (!sessionId) return;

  // ノートパネル更新は 2 段階:
  //   ① 曲切替直後: trivia を待たず基本情報 (曲名 / アーティスト / アルバム) だけで即 push
  //   ② trivia 取得後: 同 jobId で 2 回目 push して trivia 詳細を追記
  // これで切替の瞬間にノートパネルに曲名が出て、trivia は遅れて埋まる。
  const reportJobId = Date.now();
  const { pushToSession } = await import("@/lib/jobs/events");
  try {
    pushToSession(sessionId, {
      type: "report_update",
      jobId: reportJobId,
      title: `再生中: ${np.title}`,
      markdown: buildSongChangeMarkdown(np, null),
    });
  } catch (e) {
    console.warn("[song-change] initial report push failed:", e);
  }

  // trivia 取得 (= SDK 先読みで cache に温まってればゼロ待ち、未 hit なら fetch)
  let trivia: { trivia: string; markdown: string } | null = null;
  try {
    const { fetchTrackTrivia } = await import("@/lib/music-trivia");
    trivia = await fetchTrackTrivia(np.title, np.artist ?? null, np.id ?? null);
  } catch (e) {
    console.warn("[song-change] trivia fetch failed:", e);
  }

  // trivia 取得できたら 2 回目 push (= 同 jobId で上書き、ノートパネルに詳細追記)
  if (trivia?.markdown) {
    try {
      pushToSession(sessionId, {
        type: "report_update",
        jobId: reportJobId,
        title: `再生中: ${np.title}`,
        markdown: buildSongChangeMarkdown(np, trivia.markdown),
      });
    } catch (e) {
      console.warn("[song-change] trivia report push failed:", e);
    }
  }

  // 通知設定 (= notification_settings.music) を v2 shape で参照。
  // toast / 履歴は dispatchNotification 経由 (= matrix の toast_* を respect)。
  // speak は下の internal /api/chat fire で動的予告文を投げる (= 動的 speakText が
  // 要るため dispatchNotification の静的 speakText では不足)。
  // rule.speakFor(state) が false なら fire skip (= 設定 BYPASS にならないように)。
  let shouldSpeak = false;
  try {
    const { getRule } = await import("@/lib/notification-settings");
    const { getEffectiveState } = await import("@/lib/activity");
    const { dispatchNotification } = await import("@/lib/notifications");
    const rule = await getRule("music");
    const rawState = await getEffectiveState(sessionId);
    const matrixState: "online" | "away" | "focus" =
      rawState === "private" ? "focus" : rawState;
    shouldSpeak =
      matrixState === "online"
        ? rule.speakOnline
        : matrixState === "away"
          ? rule.speakAway
          : rule.speakFocus;

    // toast / 履歴 / Discord 配信は dispatchNotification 経由 (= skipAutoSpeak で
    // 二重 speak 防止)。music のデフォルトは toast=false なので大抵バッジは出ないが、
    // user が toast を有効化すれば表示される。履歴は常に残る。
    await dispatchNotification({
      sessionId,
      kind: "music",
      importance: "low",
      title: `再生中: ${np.title}`,
      preview: [np.artist, np.album].filter(Boolean).join(" / ") || undefined,
      bodyMd: buildSongChangeMarkdown(np, trivia?.markdown ?? null),
      payload: {
        title: np.title,
        artist: np.artist,
        album: np.album,
        track_id: np.id,
      },
      skipAutoSpeak: true,
    });
  } catch (e) {
    console.warn("[song-change] dispatch failed:", e);
  }
  if (!shouldSpeak) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[song-change] speak fire skipped by rule");
    }
    return;
  }

  // 内部 /api/chat に source=cron で投げて Yui に短く声かけさせる。
  // フォーマット指定の出典: bfc9e5b "Fix Yui never introducing the first track, and reshape song intros"
  // — 「切り替わりました」「次の曲は」「あら」等を禁止し、体言止め＋『です』で締める。
  const parts = [np.title, np.artist, np.album].filter(Boolean).join(" / ");
  const promptLines = [
    "[system trigger: song-changed]",
    `現在の曲: ${parts}`,
  ];
  if (trivia?.trivia) {
    promptLines.push("", "## この曲についての解説 (出典: web 検索)", trivia.trivia, "");
  }
  promptLines.push(
    "ご主人様に短く 2-4 文で、曲を紹介してください。",
    "形式: 1 文目は「○○ (アーティスト名)『曲名』です。」のように体言止め＋『です』で締める。",
    "「あら」「あの」「ふふ」等の感嘆詞・笑い声で文を始めない。",
    "「切り替わりました」「次の曲は」「変わりましたよ」「いま流れているのは」等の遷移表現は使わない。",
    trivia?.trivia
      ? "2 文目以降は、上記の解説からファクト 1-2 個 (制作年・タイアップ・エピソード等) を結衣の言葉でピックアップして自然に語る。解説全文の読み上げではなく、話題のネタにする感覚で。"
      : "続けて、有名な曲・アーティストなら 1 文で短くコメントを添える (無名なら省略可)。",
    "(これは Yui からの自発的な声かけです。ユーザー発話ではありません)"
  );
  const prompt = promptLines.join("\n");
  const port = process.env.PORT ?? "3000";
  try {
    const { internalFetch } = await import("@/lib/internal-fetch");
    await internalFetch(`http://localhost:${port}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: prompt }],
        sessionId,
        source: "cron",
      }),
    });
  } catch (e) {
    console.warn("[song-change] notify failed:", e);
  }
}

function buildSongChangeMarkdown(np: NowPlaying, trivia: string | null = null): string {
  const lines: string[] = [];
  lines.push(`**現在の曲**: ${np.title}`);
  if (np.artist) lines.push(`**アーティスト**: ${np.artist}`);
  if (np.album) lines.push(`**アルバム**: ${np.album}`);
  if (np.durationMs) {
    const min = Math.floor(np.durationMs / 60000);
    const sec = Math.floor((np.durationMs % 60000) / 1000);
    lines.push(`**長さ**: ${min}:${String(sec).padStart(2, "0")}`);
  }
  if (trivia) {
    lines.push("", "---", "", trivia);
  }
  return lines.join("\n\n");
}

export function getNowPlaying(): NowPlaying | null {
  return globalThis.__vroidMusicNowPlaying ?? null;
}

/** 現在の再生コンテキストを設定 (specialist の play_* 内で呼ぶ) */
export function setMusicContext(
  ctx: { kind: TrackContainerKind; id: string; name?: string } | null
): void {
  globalThis.__vroidMusicContext = ctx;
}

/** in-memory 履歴 (新しい順 / id 重複除去)。DB ロードは別関数。 */
export function getTrackHistory(limit = 20): TrackHistoryEntry[] {
  const seen = new Set<string>();
  const out: TrackHistoryEntry[] = [];
  for (const entry of trackHistory) {
    const key = entry.track.id ?? entry.track.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
    if (out.length >= limit) break;
  }
  return out;
}

/** DB の永続履歴を新しい順に取得 (id 重複は除去)。 */
export async function loadTrackHistoryFromDb(
  limit = 30
): Promise<TrackHistoryEntry[]> {
  const { db } = await import("@/db/client");
  const { musicTrackHistory } = await import("@/db/schema");
  const { desc } = await import("drizzle-orm");
  const rows = await db
    .select()
    .from(musicTrackHistory)
    .orderBy(desc(musicTrackHistory.playedAt))
    .limit(limit * 3); // 重複除去のため多めに取って絞る
  const seen = new Set<string>();
  const out: TrackHistoryEntry[] = [];
  for (const r of rows) {
    const key = r.trackId ?? r.title;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      timestamp: r.playedAt.getTime(),
      track: {
        id: r.trackId ?? undefined,
        title: r.title,
        artist: r.artist ?? undefined,
        album: r.album ?? undefined,
        durationMs: r.durationMs ?? undefined,
        updatedAt: r.playedAt.getTime(),
      },
      containerKind: (r.containerKind ?? undefined) as TrackContainerKind | undefined,
      containerId: r.containerId ?? undefined,
      containerName: r.containerName ?? undefined,
    });
    if (out.length >= limit) break;
  }
  return out;
}

async function persistTrackToDb(entry: TrackHistoryEntry): Promise<void> {
  const { db } = await import("@/db/client");
  const { musicTrackHistory } = await import("@/db/schema");
  const { addXp } = await import("@/lib/xp");
  const [row] = await db
    .insert(musicTrackHistory)
    .values({
      trackId: entry.track.id ?? null,
      title: entry.track.title,
      artist: entry.track.artist ?? null,
      album: entry.track.album ?? null,
      durationMs: entry.track.durationMs ?? null,
      containerKind: entry.containerKind ?? null,
      containerId: entry.containerId ?? null,
      containerName: entry.containerName ?? null,
      playedAt: new Date(entry.timestamp),
    })
    .returning({ id: musicTrackHistory.id });
  // 曲再生 = music_played +0.5 XP (薄め、上限はトラッキング側で十分)
  if (row) {
    void addXp({
      eventType: "music_played",
      refTable: "music_track_history",
      refId: row.id,
    });
  }
}

// ============================================================
// Spotify now-playing 更新パス (= push + on-demand のみ、定期 polling 無し)
// ------------------------------------------------------------
// 旧設計: 30s 間隔の server-side polling で常時最新化していたが、Web Playback SDK の
// player_state_changed event でブラウザ側が即時 push できるようになったので撤廃。
// 現在の流れ:
//   1. SDK push: SpotifyWebPlayer が player_state_changed → POST /api/spotify/poll-now →
//      kickSpotifyPollNow() → cache 更新 (track 変化 / pause 変化を即時反映)
//   2. ENV on-demand: buildEnvironmentBlock 内 safeNowPlaying() が cache > 10s stale なら
//      kickSpotifyPollNow() を await (= ブラウザリロード直後の初手チャットでも fresh)
// 未連携 / token 失効は呼出元から見て黙って null。
// ============================================================

/** Spotify Web API を一度叩いて in-memory now-playing を更新する */
async function pollSpotifyOnce(): Promise<void> {
  try {
    // 動的 import (循環依存 / startup ordering を避ける)
    const { getNowPlaying: spotifyGetNowPlaying } = await import("./spotify");
    const np = await spotifyGetNowPlaying();
    if (process.env.NODE_ENV !== "production") {
      console.log("[pollSpotifyOnce] result", np ? { trackName: np.trackName, uri: np.trackUri } : null);
    }
    if (!np) {
      setNowPlaying(null);
      return;
    }
    setNowPlaying({
      id: np.trackUri,
      title: np.trackName,
      artist: np.artistNames.join(", "),
      album: np.albumName,
      durationMs: np.durationMs,
      isPlaying: np.isPlaying,
      updatedAt: Date.now(),
    });
  } catch (e) {
    // 未連携 / token 失効は黙ってスキップ (キャッシュは前回値のままにせず null へ)
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("not connected") || msg.includes("Not Connected")) {
      setNowPlaying(null);
    } else if (process.env.NODE_ENV !== "production") {
      console.warn("[music-poller] failed:", msg);
    }
  }
}

/**
 * 即時 poll を要求するための export。
 *  - /api/spotify/poll-now (Web Playback SDK の player_state_changed event 受信時)
 *  - environment.ts の safeNowPlaying() (= ENV cache が stale な時の on-demand 更新)
 * から呼ばれる。
 */
export async function kickSpotifyPollNow(): Promise<void> {
  await pollSpotifyOnce();
}
