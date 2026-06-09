"use client";

/**
 * Spotify Web Playback SDK loader (= ブラウザ自体を Spotify Connect デバイス化)。
 *
 * 目的:
 *   - Premium ユーザのブラウザで音楽を直接鳴らす
 *   - Spotify アプリ (= phone/desktop) を別途開かなくても、Yui に依頼するだけで再生される
 *   - SDK 初期化 → device 登録 → 即 transferPlayback で active 化 → 以降の API 呼び出し
 *     (= specialist の play / pause / next) は全部このブラウザに飛ぶ
 *
 * 不可視コンポーネント。page.tsx で 1 度 mount される。
 * 失敗 (未連携 / Premium 必須 / SDK ロード失敗) は静かに skip。
 */
import { useEffect, useRef } from "react";

// ---- minimal types for the SDK shim (公式型定義は @types/spotify-web-playback-sdk だが
// 単純な使い方なので自前で型を持つ) ----

type SpotifyPlayerOptions = {
  name: string;
  getOAuthToken: (cb: (token: string) => void) => void;
  volume?: number;
};

type SpotifyPlaybackTrack = {
  uri: string;
  id: string | null;
  name: string;
  duration_ms: number;
};

type SpotifyPlaybackArtist = { name: string };

type SpotifyPlaybackTrackFull = SpotifyPlaybackTrack & {
  artists?: SpotifyPlaybackArtist[];
};

type SpotifyPlaybackState = {
  paused: boolean;
  position: number;
  duration: number;
  track_window: {
    current_track: SpotifyPlaybackTrackFull | null;
    next_tracks?: SpotifyPlaybackTrackFull[];
  };
};

type SpotifyPlayerEventMap = {
  ready: { device_id: string };
  not_ready: { device_id: string };
  initialization_error: { message: string };
  authentication_error: { message: string };
  account_error: { message: string };
  playback_error: { message: string };
  player_state_changed: SpotifyPlaybackState | null;
};

type SpotifyPlayer = {
  connect: () => Promise<boolean>;
  disconnect: () => void;
  addListener: <K extends keyof SpotifyPlayerEventMap>(
    event: K,
    cb: (data: SpotifyPlayerEventMap[K]) => void
  ) => void;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  togglePlay: () => Promise<void>;
  seek: (positionMs: number) => Promise<void>;
  previousTrack: () => Promise<void>;
  nextTrack: () => Promise<void>;
  setVolume: (volume: number) => Promise<void>;
  getCurrentState: () => Promise<SpotifyPlaybackState | null>;
  activateElement: () => Promise<void>;
};

declare global {
  interface Window {
    onSpotifyWebPlaybackSDKReady?: () => void;
    Spotify?: {
      Player: new (opts: SpotifyPlayerOptions) => SpotifyPlayer;
    };
    // SpotifyWebPlayer が成功した player を expose する。MusicModal から
    // transport control (pause/resume/seek/etc) を SDK 直接で叩くため。
    __yuiSpotifyPlayer?: SpotifyPlayer | null;
  }
}

const SDK_URL = "https://sdk.scdn.co/spotify-player.js";
const SCRIPT_ID = "spotify-web-playback-sdk";
const PLAYER_NAME = "Yui Agent (Web)";
const MUSIC_VOLUME_KEY = "vroid-music-volume";

/** localStorage から 0-1 の volume を読む。範囲外/NaN は fallback。 */
function readStoredMusicVolume(fallback: number): number {
  if (typeof window === "undefined") return fallback;
  const raw = window.localStorage.getItem(MUSIC_VOLUME_KEY);
  if (raw == null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

export default function SpotifyWebPlayer() {
  const initializedRef = useRef(false);

  // IconBar の全体ミュートボタン / MusicModal のスライダーから dispatch される
  // "vroid-music-volume-change" event を常時 listen し、Spotify SDK の setVolume に
  // 同期する。MusicModal は閉じてる間 mount されないので、SDK player への配線は
  // ここで保つ必要がある (= Next 15 → Next 16 移行で消えた経路を再構築)。
  useEffect(() => {
    if (typeof window === "undefined") return;
    const sync = () => {
      const v = readStoredMusicVolume(0.5);
      const p = window.__yuiSpotifyPlayer;
      if (!p) return; // SDK 未 ready なら次回 event で拾われる、または ready 時に初期化される
      void p.setVolume(v).catch(() => { /* noop */ });
    };
    window.addEventListener("vroid-music-volume-change", sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener("vroid-music-volume-change", sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  useEffect(() => {
    if (initializedRef.current) return;
    initializedRef.current = true;

    // 注意: React 19 Strict Mode dev では useEffect が mount → cleanup → mount と 2 回走る。
    // 旧実装は closure 変数 `cancelled` を cleanup で true にし、SDK ready callback (= 数百 ms 後に発火) を
    // 早期 return させていた。その結果:
    //   1) Mount 1: cancelled=false でセット、SDK script inject、SDK ready callback を window に登録
    //   2) Cleanup 1: cancelled=true (← Mount 1 のクロージャを汚染)
    //   3) Mount 2: initializedRef で skip
    //   4) SDK ロード完了 → ready callback → initPlayer() を呼ぶが、Mount 1 のクロージャの cancelled が true → 早期 return
    //   → Player.connect() に到達せず Web Playback SDK device が登録されない
    // 解法: cancelled 廃止。cleanup でも player を disconnect しない (= SpotifyWebPlayer は
    // page.tsx で 1 回 mount される常駐 component、SPA 中は unmount されない前提)。
    // 二重 init は window.__yuiSpotifyPlayer の既存チェックで防ぐ。
    let player: SpotifyPlayer | null = null;

    const fetchToken = async (cb: (token: string) => void) => {
      try {
        const res = await fetch("/api/spotify/token", { cache: "no-store" });
        if (!res.ok) return; // 未連携 / 失敗時は何もしない → SDK 認証エラーで自然停止
        const j = (await res.json()) as { access_token?: string };
        if (j.access_token) cb(j.access_token);
      } catch {
        /* noop */
      }
    };

    const transferToBrowserDevice = async (deviceId: string) => {
      try {
        // リロード時に再生継続するため、転送前に「現在再生中か?」を確認する。
        // - 再生中 → play: true で transfer (= 別 device で鳴ってた音楽がブラウザに引き継がれる)
        // - 停止中 → play: false (= 何も鳴らない、specialist の次の play で始まる)
        let shouldPlay = false;
        try {
          const npRes = await fetch("/api/spotify/now-playing", { cache: "no-store" });
          if (npRes.ok) {
            const { nowPlaying } = (await npRes.json()) as {
              nowPlaying: { isPlaying?: boolean } | null;
            };
            shouldPlay = !!nowPlaying?.isPlaying;
          }
        } catch {
          /* noop — fail-safe で false */
        }
        await fetch("/api/spotify/control", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "transfer", deviceId, play: shouldPlay }),
        });
        // フロントの他コンポーネント (= IconBar / MusicModal) に「ブラウザがアクティブに
        // なった」シグナル飛ばす — 必要なら status 再評価が走る
        window.dispatchEvent(
          new CustomEvent("yui-spotify-status-recheck")
        );
      } catch (e) {
        console.warn("[spotify-web-player] transfer failed:", e);
      }
    };

    const initPlayer = async () => {
      // 連携してなければ何もしない (token endpoint が 401 で空回り)
      try {
        const r = await fetch("/api/spotify/status", { cache: "no-store" });
        if (!r.ok) return;
        const s = (await r.json()) as { apiWorking?: boolean };
        if (!s.apiWorking) return;
      } catch {
        return;
      }
      if (!window.Spotify) return; // SDK ready 前
      if (window.__yuiSpotifyPlayer || player) return; // 二重 init 防止 (Strict mode の再呼出し / SDK 既ロード時)

      player = new window.Spotify.Player({
        name: PLAYER_NAME,
        getOAuthToken: (cb) => void fetchToken(cb),
        // localStorage の最終 volume (= mute 状態含む) を初期値に。リロード後も
        // ミュートが維持される。未設定なら 0.5 (= SDK 既定)。
        volume: readStoredMusicVolume(0.5),
      });

      player.addListener("ready", ({ device_id }) => {
        // MusicModal が SDK 直接 control (pause/resume/seek/etc) するために expose
        window.__yuiSpotifyPlayer = player;
        if (process.env.NODE_ENV !== "production") {
          console.log("[spotify-sdk] ready, player exposed as window.__yuiSpotifyPlayer", device_id);
        }
        void transferToBrowserDevice(device_id);
      });
      player.addListener("not_ready", ({ device_id }) => {
        if (process.env.NODE_ENV !== "production") {
          console.log("[spotify-web-player] device offline:", device_id);
        }
      });
      player.addListener("initialization_error", ({ message }) => {
        console.warn("[spotify-web-player] init error:", message);
      });
      player.addListener("authentication_error", ({ message }) => {
        console.warn("[spotify-web-player] auth error:", message);
      });
      player.addListener("account_error", ({ message }) => {
        // Free アカウントだとここに落ちる
        console.warn("[spotify-web-player] account error (Premium 必須):", message);
      });
      player.addListener("playback_error", ({ message }) => {
        console.warn("[spotify-web-player] playback error:", message);
      });

      // 曲が切り替わった瞬間 + 再生/停止が切り替わった瞬間に server poll を kick →
      // setNowPlaying → ENV ブロックが即時更新される (= Yui が「停止中」を即時に認識)。
      // state は volume / position 変化でも頻発するので track URI / paused 変化のみ trigger。
      // 同時に、track_window.next_tracks[0] の trivia を先読みでサーバキャッシュに温めて
      // 次曲切り替え時にゼロ待ちで返るようにする。
      let lastTrackUri: string | null = null;
      let lastPaused: boolean | null = null;
      let lastPrefetchedUri: string | null = null;
      player.addListener("player_state_changed", (state) => {
        if (!state) return;
        const uri = state.track_window?.current_track?.uri ?? null;
        const paused = state.paused;
        // 初回判定: lastPaused が null の間 = SDK 接続後まだ 1 度も state を受け取ってない。
        // SDK 初回 ready 直後の player_state_changed は「既に再生中の曲をそのまま読み込んだ」
        // 状態通知なので、baseline として lastTrackUri / lastPaused だけ覚えて kick しない。
        // 旧コードは trackChanged (uri !== null) を先に判定していたため初回も poll-now を
        // 叩いてしまい、Fast Refresh で SpotifyWebPlayer が re-mount するたびに setNowPlaying
        // → notifyYuiSongChanged → Yui ターン (= API 課金) を空発火していた。
        const isFirstEvent = lastPaused === null;
        if (process.env.NODE_ENV !== "production") {
          console.log("[spotify-sdk] state_changed", {
            uri,
            same: uri === lastTrackUri,
            paused,
            pausedChanged: !isFirstEvent && paused !== lastPaused,
            isFirstEvent,
            track: state.track_window?.current_track?.name,
          });
        }
        if (isFirstEvent) {
          if (uri) lastTrackUri = uri;
          lastPaused = paused;
          return;
        }
        const trackChanged = uri && uri !== lastTrackUri;
        const pausedChanged = paused !== lastPaused;
        if (trackChanged || pausedChanged) {
          if (uri) lastTrackUri = uri;
          lastPaused = paused;
          if (process.env.NODE_ENV !== "production") {
            console.log(
              `[spotify-sdk] ${trackChanged ? "track" : "paused"} changed → kick /api/spotify/poll-now`
            );
          }
          void fetch("/api/spotify/poll-now", { method: "POST" }).catch(() => {
            /* noop — 失敗しても次の player_state_changed か ENV on-demand poll
               (= safeNowPlaying の stale 判定) で拾われるので致命的ではない */
          });
        }
        // 次曲の trivia を先読み (= 曲が切り替わる前にキャッシュ準備)
        const next = state.track_window?.next_tracks?.[0];
        if (next && next.uri && next.uri !== lastPrefetchedUri) {
          lastPrefetchedUri = next.uri;
          if (process.env.NODE_ENV !== "production") {
            console.log("[spotify-sdk] prefetch next trivia:", next.name);
          }
          void fetch("/api/music/prefetch-trivia", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              title: next.name,
              artist: next.artists?.map((a) => a.name).join(", ") ?? null,
              trackUri: next.uri,
            }),
          }).catch(() => {
            /* noop — 先読み失敗は致命的ではない */
          });
        }
      });

      void player.connect();
    };

    // SDK ready コールバックを先に設定 (SDK ロードと同時に呼ばれる)
    const existingHandler = window.onSpotifyWebPlaybackSDKReady;
    window.onSpotifyWebPlaybackSDKReady = () => {
      existingHandler?.();
      void initPlayer();
    };

    // SDK script を inject (既にあれば skip)
    if (!document.getElementById(SCRIPT_ID)) {
      const s = document.createElement("script");
      s.id = SCRIPT_ID;
      s.src = SDK_URL;
      s.async = true;
      document.body.appendChild(s);
    } else if (window.Spotify) {
      // SDK 既ロード済 → 即 init
      void initPlayer();
    }

    // 意図的に no-op cleanup: Strict Mode dev の fake unmount で player を切ると
    // SDK ready callback が空振りして二度と Web Playback device が登録されなくなる。
    // SpotifyWebPlayer は page.tsx の常駐 component なので、本物の unmount は
    // ブラウザのページ遷移時にしか起きず、その時はブラウザ側で全部解放される。
  }, []);

  return null;
}
