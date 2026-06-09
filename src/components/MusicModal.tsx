"use client";

/**
 * Spotify 再生モーダル (Apple Music MusicKit JS から完全移行)。
 *
 * - GET /api/spotify/now-playing を 5 秒間隔で polling
 * - 操作 (再生/一時停止/次/前/音量/デバイス transfer) は全て POST /api/spotify/control
 * - 連携未済 (401) → 「連携してください」+ 設定への誘導
 * - Premium 必須 (402) → inline メッセージ
 *
 * 既存 UI レイアウト (アートワーク + meta + 進捗バー + コントロール + 音量 + 履歴) は維持。
 * MusicKit JS / lipsync / audio analyser は削除済。Spotify は audio data に
 * アクセスできないので Yui の口パク連動は今回スコープ外。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";

type Props = {
  open: boolean;
  onClose: () => void;
};

// /api/spotify/now-playing が返す shape (server lib/spotify.ts の NowPlaying と一致)
type NowPlaying = {
  trackName: string;
  artistNames: string[];
  albumName: string;
  artworkUrl: string | null;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  trackUri: string;
};

type ConnectionState =
  | { phase: "loading" }
  | { phase: "not-connected" }
  | { phase: "connected" }
  | { phase: "premium-required" }
  | { phase: "error"; message: string };

const POLL_INTERVAL_MS = 5_000;
const MUSIC_VOLUME_KEY = "vroid-music-volume";

export default function MusicModal({ open, onClose }: Props) {
  const [conn, setConn] = useState<ConnectionState>({ phase: "loading" });
  const [nowPlaying, setNowPlaying] = useState<NowPlaying | null>(null);
  // 楽観的 UI 用ローカル音量 (0-100)。スライダー操作後に確定値で同期される。
  // localStorage 同期は useState lazy init で取り込む (React 19 推奨)。
  const [volumePercent, setVolumePercent] = useState<number>(() => {
    if (typeof window === "undefined") return 50;
    const v = window.localStorage.getItem(MUSIC_VOLUME_KEY);
    const n = v == null ? 1 : Number(v);
    if (!Number.isFinite(n)) return 50;
    return Math.round(Math.max(0, Math.min(1, n)) * 100);
  });
  // 1 秒刻みで進む displayed progress (= サーバ polling 5 秒間隔の隙間を埋める)
  const [displayedProgressMs, setDisplayedProgressMs] = useState<number>(0);
  const dialogRef = useRef<HTMLDivElement>(null);
  // ユーザがスライダーを動かしている最中はサーバ値で上書きしないようにする
  const isVolumeAdjustingRef = useRef(false);
  // seek スライダー操作中フラグ (= drag 中はサーバ値で上書きしない、release で seek POST)
  const isSeekingRef = useRef(false);

  const fetchNowPlaying = useCallback(async () => {
    try {
      const res = await fetch("/api/spotify/now-playing", { cache: "no-store" });
      if (res.status === 401) {
        setConn({ phase: "not-connected" });
        setNowPlaying(null);
        notifySpotifyStatus({ apiWorking: false, connected: false });
        return;
      }
      if (res.status === 402) {
        setConn({ phase: "premium-required" });
        notifySpotifyStatus({ apiWorking: false, connected: true });
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setConn({ phase: "error", message: data.error ?? `HTTP ${res.status}` });
        return;
      }
      const data = (await res.json()) as { nowPlaying: NowPlaying | null };
      setNowPlaying(data.nowPlaying);
      // ユーザが drag 中はサーバ値で上書きしない
      if (!isSeekingRef.current) {
        setDisplayedProgressMs(data.nowPlaying?.progressMs ?? 0);
      }
      setConn({ phase: "connected" });
      notifySpotifyStatus({ apiWorking: true, connected: true });
    } catch (e) {
      setConn({
        phase: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  // 開いてる間 polling
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch + polling
    void fetchNowPlaying();
    const id = setInterval(() => {
      void fetchNowPlaying();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [open, fetchNowPlaying]);

  // IconBar の全体ミュート / ストレージ書き換えで volume が外部から変わった時、
  // スライダー位置 (= volumePercent state) を追従させる。SDK への実適用は
  // SpotifyWebPlayer 側で同 event を listen して setVolume するので、ここは表示同期のみ。
  useEffect(() => {
    const sync = () => {
      const raw = window.localStorage.getItem(MUSIC_VOLUME_KEY);
      const n = raw == null ? 1 : Number(raw);
      if (!Number.isFinite(n)) return;
      const pct = Math.round(Math.max(0, Math.min(1, n)) * 100);
      // user が今スライダーを動かしている最中なら上書きしない
      if (isVolumeAdjustingRef.current) return;
      setVolumePercent(pct);
    };
    window.addEventListener("vroid-music-volume-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("vroid-music-volume-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  // 1 秒刻みで displayedProgressMs を進める (モーダル開閉中 + 再生中 + drag 中でない時)
  useEffect(() => {
    if (!open) return;
    if (!nowPlaying?.isPlaying) return;
    const id = setInterval(() => {
      if (isSeekingRef.current) return;
      setDisplayedProgressMs((prev) => {
        const dur = nowPlaying?.durationMs ?? 0;
        const next = prev + 1000;
        return dur > 0 ? Math.min(next, dur) : next;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [open, nowPlaying?.isPlaying, nowPlaying?.durationMs]);

  // ESC で閉じる + body scroll 抑制
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  // (旧: useEffect で localStorage を読んでた処理は上の useState lazy init に統合済み)

  async function postControl(body: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch("/api/spotify/control", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.status === 401) {
        setConn({ phase: "not-connected" });
        return;
      }
      if (res.status === 402) {
        setConn({ phase: "premium-required" });
        return;
      }
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        console.warn("[MusicModal] control failed:", data.error ?? res.status);
      }
      // 控えめに refresh (= 楽観 UI の補正)
      setTimeout(() => void fetchNowPlaying(), 300);
    } catch (e) {
      console.warn("[MusicModal] control error:", e);
    }
  }

  // 全 transport control は Web Playback SDK の Player 直接呼び出しで処理する。
  // 利点: Web API (/me/player/*) を経由しないので scope 不足や 4xx を回避でき、
  //       active device 解決も SDK 内部で行われる。
  // SDK 不在 (= 未連携 / Premium 無し / SDK 初期化失敗) 時のみ HTTP API にフォールバック。
  async function withSdkOrFallback(
    sdkOp: () => Promise<void>,
    fallback: () => Promise<void>
  ): Promise<void> {
    const p = window.__yuiSpotifyPlayer;
    if (p) {
      try {
        await sdkOp();
        setTimeout(() => void fetchNowPlaying(), 300);
        return;
      } catch (e) {
        console.warn("[MusicModal] SDK op failed, falling back to HTTP:", e);
      }
    }
    await fallback();
  }

  function togglePlayPause() {
    void withSdkOrFallback(
      async () => {
        const p = window.__yuiSpotifyPlayer!;
        await p.togglePlay();
      },
      () =>
        postControl({
          action: nowPlaying?.isPlaying ? "pause" : "play",
        })
    );
  }
  function nextTrack() {
    void withSdkOrFallback(
      async () => {
        await window.__yuiSpotifyPlayer!.nextTrack();
      },
      () => postControl({ action: "next" })
    );
  }
  function prevTrack() {
    void withSdkOrFallback(
      async () => {
        await window.__yuiSpotifyPlayer!.previousTrack();
      },
      () => postControl({ action: "prev" })
    );
  }
  function onVolumeChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = Number(e.target.value);
    if (!Number.isFinite(v)) return;
    isVolumeAdjustingRef.current = true;
    setVolumePercent(v);
    window.localStorage.setItem(MUSIC_VOLUME_KEY, String(v / 100));
  }
  function onVolumeCommit() {
    const v = volumePercent;
    void withSdkOrFallback(
      async () => {
        await window.__yuiSpotifyPlayer!.setVolume(v / 100);
      },
      () => postControl({ action: "volume", volumePercent: v })
    ).finally(() => {
      setTimeout(() => {
        isVolumeAdjustingRef.current = false;
      }, 1500);
    });
  }

  // seek スライダー drag 中 (= onChange) は楽観 UI で displayedProgressMs だけ更新
  function onSeekChange(e: React.ChangeEvent<HTMLInputElement>) {
    const sec = Number(e.target.value);
    if (!Number.isFinite(sec)) return;
    isSeekingRef.current = true;
    setDisplayedProgressMs(Math.max(0, Math.floor(sec * 1000)));
  }
  // release で実 seek
  function onSeekCommit() {
    const positionMs = displayedProgressMs;
    void withSdkOrFallback(
      async () => {
        await window.__yuiSpotifyPlayer!.seek(positionMs);
      },
      () => postControl({ action: "seek", positionMs })
    ).finally(() => {
      setTimeout(() => {
        isSeekingRef.current = false;
      }, 1000);
    });
  }

  const { mounted, closing } = useModalTransition(open);
  if (!mounted) return null;

  return (
    <div
      className={`music-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`music-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="music-modal-title"
        tabIndex={-1}
      >
        <header className="music-modal-header">
          <h1 id="music-modal-title">Music</h1>
          <button
            type="button"
            className="music-modal-close"
            onClick={onClose}
            aria-label="閉じる"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </header>
        <div className="music-modal-body">
          {conn.phase === "loading" && (
            <p className="settings-muted">読み込み中…</p>
          )}
          {conn.phase === "not-connected" && <NotConnectedView onClose={onClose} />}
          {conn.phase === "error" && (
            <div className="settings-flash settings-flash-err">
              <span>エラー: {conn.message}</span>
            </div>
          )}
          {conn.phase === "connected" && (
            <Player
              nowPlaying={nowPlaying}
              displayedProgressMs={displayedProgressMs}
              volumePercent={volumePercent}
              premiumRequired={false}
              onTogglePlay={togglePlayPause}
              onNext={nextTrack}
              onPrev={prevTrack}
              onVolumeChange={onVolumeChange}
              onVolumeCommit={onVolumeCommit}
              onSeekChange={onSeekChange}
              onSeekCommit={onSeekCommit}
            />
          )}
          {conn.phase === "premium-required" && <PremiumRequiredView onClose={onClose} />}
        </div>
      </div>
    </div>
  );
}

function NotConnectedView({ onClose }: { onClose: () => void }) {
  return (
    <div className="settings-section-body">
      <p className="settings-section-sub">
        Spotify と未連携です。設定から連携してください。
        連携後はジャンルや曲名で Yui に依頼すると、Spotify Connect 経由で再生されます。
      </p>
      <button
        type="button"
        className="settings-btn settings-btn-primary"
        onClick={() => {
          onClose();
          window.dispatchEvent(
            new CustomEvent("yui-open-settings", { detail: { tab: "integrations" } })
          );
        }}
      >
        設定を開く
      </button>
    </div>
  );
}

/** Spotify status の即時変化を IconBar 等の他コンポーネントに通知 + cache 更新 */
function notifySpotifyStatus(detail: { apiWorking: boolean; connected: boolean }) {
  try {
    const CACHE_KEY = "vroid-spotify-status";
    if (detail.apiWorking) {
      window.localStorage.setItem(
        CACHE_KEY,
        JSON.stringify({ ok: true, ts: Date.now() })
      );
    } else {
      window.localStorage.removeItem(CACHE_KEY);
    }
    window.dispatchEvent(
      new CustomEvent("yui-spotify-status-change", { detail })
    );
  } catch {
    /* noop */
  }
}

function PremiumRequiredView({ onClose }: { onClose: () => void }) {
  return (
    <div className="settings-section-body">
      <p className="settings-section-sub">
        <strong>Spotify Web API が使えません。</strong>
        <br />
        Spotify の仕様により、アプリ owner (= ご主人様の Spotify アカウント) が
        <strong>Premium に加入していないと Web API は一切叩けません</strong> (Development Mode の制約)。
      </p>
      <p className="settings-section-sub">
        <a
          href="https://www.spotify.com/jp/premium/"
          target="_blank"
          rel="noreferrer noopener"
          style={{ textDecoration: "underline" }}
        >
          Spotify Premium に加入
        </a>{" "}
        してから設定を再確認してください。
      </p>
      <button
        type="button"
        className="settings-btn settings-btn-primary"
        onClick={() => {
          onClose();
          window.dispatchEvent(
            new CustomEvent("yui-open-settings", { detail: { tab: "integrations" } })
          );
        }}
      >
        設定を開く
      </button>
    </div>
  );
}

function Player({
  nowPlaying,
  displayedProgressMs,
  volumePercent,
  premiumRequired,
  onTogglePlay,
  onNext,
  onPrev,
  onVolumeChange,
  onVolumeCommit,
  onSeekChange,
  onSeekCommit,
}: {
  nowPlaying: NowPlaying | null;
  displayedProgressMs: number;
  volumePercent: number;
  premiumRequired: boolean;
  onTogglePlay: () => void;
  onNext: () => void;
  onPrev: () => void;
  onVolumeChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onVolumeCommit: () => void;
  onSeekChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onSeekCommit: () => void;
}) {
  const hasTrack = !!nowPlaying;
  const isPlaying = !!nowPlaying?.isPlaying;

  return (
    <div className="music-player">
      <div className="music-art">
        {nowPlaying?.artworkUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={nowPlaying.artworkUrl} alt={nowPlaying.albumName} />
        ) : (
          <div className="music-art-placeholder" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 18V5l12-2v13" />
              <circle cx="6" cy="18" r="3" />
              <circle cx="18" cy="16" r="3" />
            </svg>
          </div>
        )}
      </div>

      <div className="music-meta">
        <div className="music-title">{nowPlaying?.trackName ?? "再生中の曲はありません"}</div>
        <div className="music-artist">
          {nowPlaying?.artistNames.join(", ") ?? ""}
          {nowPlaying?.albumName ? ` — ${nowPlaying.albumName}` : ""}
        </div>
      </div>

      <div className="music-progress-row">
        <span className="music-time">{fmtTime(displayedProgressMs / 1000)}</span>
        <input
          name="music-progress"
          type="range"
          min={0}
          max={nowPlaying ? Math.max(1, Math.floor(nowPlaying.durationMs / 1000)) : 0}
          step={1}
          value={nowPlaying ? Math.floor(displayedProgressMs / 1000) : 0}
          onChange={onSeekChange}
          onMouseUp={onSeekCommit}
          onTouchEnd={onSeekCommit}
          onKeyUp={onSeekCommit}
          disabled={!hasTrack}
          aria-label="再生位置"
          className="music-progress"
        />
        <span className="music-time">{fmtTime((nowPlaying?.durationMs ?? 0) / 1000)}</span>
      </div>

      <div className="music-controls">
        <button type="button" onClick={onPrev} aria-label="前の曲" disabled={!hasTrack}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M6 6v12h2V6H6zm3.5 6l8.5 6V6l-8.5 6z" />
          </svg>
        </button>
        <button
          type="button"
          onClick={onTogglePlay}
          aria-label={isPlaying ? "一時停止" : "再生"}
          className="music-controls-main"
        >
          {isPlaying ? (
            <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
              <rect x="6" y="5" width="4" height="14" />
              <rect x="14" y="5" width="4" height="14" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button type="button" onClick={onNext} aria-label="次の曲" disabled={!hasTrack}>
          <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
            <path d="M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z" />
          </svg>
        </button>
      </div>

      <div className="music-volume-row">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5L6 9H2v6h4l5 4z" />
          <path d="M15.54 8.46a5 5 0 010 7.07" />
        </svg>
        <input
          name="music-volume"
          type="range"
          min={0}
          max={100}
          step={1}
          value={volumePercent}
          onChange={onVolumeChange}
          onMouseUp={onVolumeCommit}
          onTouchEnd={onVolumeCommit}
          onKeyUp={onVolumeCommit}
          aria-label="Spotify 音量"
          className="music-volume"
        />
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M11 5L6 9H2v6h4l5 4z" />
          <path d="M19.07 4.93a10 10 0 010 14.14" />
          <path d="M15.54 8.46a5 5 0 010 7.07" />
        </svg>
      </div>

      {premiumRequired && (
        <div className="settings-flash settings-flash-err">
          <span>
            この操作には Spotify Premium が必要です (Free アカウントでは再生制御不可)。
          </span>
        </div>
      )}

      <HistorySection nowPlayingId={nowPlaying?.trackUri ?? null} />
    </div>
  );
}

type HistoryItem = {
  timestamp: number;
  track: {
    id?: string;
    title: string;
    artist?: string;
    album?: string;
  };
  container: {
    kind: "playlist" | "album" | "song";
    id?: string;
    name?: string;
  } | null;
};

const SESSION_STORAGE_KEY = "vroid-chat-session-id";

function HistorySection({ nowPlayingId }: { nowPlayingId: string | null }) {
  const [items, setItems] = useState<HistoryItem[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const fetchHistory = useCallback(async () => {
    try {
      const res = await fetch("/api/music/history?limit=15");
      if (!res.ok) return;
      const data = (await res.json()) as { history: HistoryItem[] };
      setItems(data.history ?? []);
    } catch (e) {
      console.warn("[music-history] fetch failed:", e);
    }
  }, []);

  useEffect(() => {
    // 初回 mount + fetchHistory 関数変化時に履歴 fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void fetchHistory();
  }, [fetchHistory]);

  // nowPlaying が変わった = 新しい play が走った可能性 → 履歴更新
  useEffect(() => {
    const id = setTimeout(fetchHistory, 1500);
    return () => clearTimeout(id);
  }, [nowPlayingId, fetchHistory]);

  const getSessionId = (): string =>
    typeof window !== "undefined"
      ? window.localStorage.getItem(SESSION_STORAGE_KEY) ?? ""
      : "";

  const replayTrack = async (it: HistoryItem) => {
    const sessionId = getSessionId();
    if (!sessionId || !it.track.title) return;
    setBusy(`t-${it.timestamp}`);
    try {
      await fetch("/api/music/history/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "song",
          song_id: it.track.id ?? "",
          title: it.track.title,
          artist: it.track.artist,
          sessionId,
        }),
      });
    } catch (e) {
      console.warn("[music-history] replay track failed:", e);
    } finally {
      setBusy(null);
    }
  };

  const replayContainer = async (it: HistoryItem) => {
    const sessionId = getSessionId();
    if (!sessionId || !it.container || !it.container.name) return;
    setBusy(`c-${it.timestamp}`);
    try {
      await fetch("/api/music/history/replay", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "container",
          container_kind: it.container.kind,
          container_id: it.container.id ?? "",
          container_name: it.container.name,
          sessionId,
        }),
      });
    } catch (e) {
      console.warn("[music-history] replay container failed:", e);
    } finally {
      setBusy(null);
    }
  };

  if (items.length === 0) return null;

  const fmtTimestamp = (ts: number): string => {
    const d = new Date(ts);
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    const pad = (n: number) => String(n).padStart(2, "0");
    return sameDay
      ? `${pad(d.getHours())}:${pad(d.getMinutes())}`
      : `${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  return (
    <div className="music-history">
      <div className="music-history-title">最近再生した曲</div>
      <ul className="music-history-list">
        {items.map((it) => (
          <li key={it.timestamp} className="music-history-item">
            <div className="music-history-label">
              <span className="music-history-title-line">{it.track.title}</span>
              {it.track.artist && (
                <span className="music-history-sub">
                  {it.track.artist}
                  {it.container?.name && ` · ${it.container.name}`}
                </span>
              )}
            </div>
            <span className="music-history-ts">{fmtTimestamp(it.timestamp)}</span>
            <div className="music-history-actions">
              {it.container?.name && (
                <button
                  type="button"
                  className="music-history-btn"
                  onClick={() => void replayContainer(it)}
                  disabled={busy !== null}
                  title={`${it.container.kind === "playlist" ? "プレイリスト" : "アルバム"}を Spotify で再検索して再生`}
                >
                  ▶ {it.container.kind === "playlist" ? "P" : "A"}
                  {busy === `c-${it.timestamp}` && "…"}
                </button>
              )}
              <button
                type="button"
                className="music-history-btn music-history-btn-primary"
                onClick={() => void replayTrack(it)}
                disabled={busy !== null}
                title="この曲を Spotify で再検索して再生"
              >
                ▶
                {busy === `t-${it.timestamp}` && "…"}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function fmtTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s < 10 ? "0" : ""}${s}`;
}
