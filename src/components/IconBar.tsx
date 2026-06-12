"use client";

/**
 * VN 風アイコンバー (右上)。
 *
 * 各アイコンは白っぽい円形ボタン (Report Panel のグラデートーンと統一)。
 *
 * - OPTION (歯車): /settings へ移動
 * - LOG (吹き出し): 未実装 Toast
 * - NEWS (新聞アイコン): 未実装 Toast
 * - MUSIC (音符): Spotify 連携モーダルを開く
 * - MUTE (スピーカー): 音量 ON/OFF。ChatPanel の volume slider と連動
 */
import { useEffect, useState } from "react";

type Props = {
  /** OPTION ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenSettings?: () => void;
  /** MUSIC ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenMusic?: () => void;
  /** LOG ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenLog?: () => void;
  /** TODO ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenTodo?: () => void;
  /** CONTACTS ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenContacts?: () => void;
  /** DIARY ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenDiary?: () => void;
  /** NEWS ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenNews?: () => void;
  /** CALENDAR ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenCalendar?: () => void;
  /** MAIL ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenMail?: () => void;
  /** SLEEP ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenSleep?: () => void;
  onOpenHealth?: () => void;
  /** REMIND ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenReminders?: () => void;
  /** PROJ ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenProjects?: () => void;
  /** NOTES ボタンが押されたときに親で呼ぶ (modal 開く) */
  onOpenNotes?: () => void;
};

// MUTE はヘッダーの「全体ミュート」ボタン。Yui 声 + 音楽の両方を同時に on/off する。
// 個別の音量調整は SecretaryCard (Yui 声) と MusicModal (音楽) で別々に行うが、
// 「電話対応で全部すぐ黙らせたい」的な用途のために 1 ボタンで両方止める運用は残す。
// MUTE 解除時は直前の音量に戻すため、_pre-mute_ key に退避する。
const VOLUME_STORAGE_KEY = "vroid-yui-voice-volume";
const LEGACY_VOLUME_KEY = "vroid-chat-volume";
const MUSIC_VOLUME_KEY = "vroid-music-volume";
const PRE_MUTE_VOICE_KEY = "vroid-pre-mute-yui-voice-volume";
const PRE_MUTE_MUSIC_KEY = "vroid-pre-mute-music-volume";

type ToastMsg = { id: number; text: string };

export default function IconBar({ onOpenSettings, onOpenMusic, onOpenLog, onOpenTodo, onOpenContacts, onOpenDiary, onOpenNews, onOpenCalendar, onOpenMail, onOpenSleep, onOpenHealth, onOpenReminders, onOpenProjects, onOpenNotes }: Props) {
  const [muted, setMuted] = useState<boolean>(false);
  const [toasts, setToasts] = useState<ToastMsg[]>([]);
  const [mounted, setMounted] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState<boolean>(true);
  // Spotify Web API が叩ける状態か (= connected かつ apiWorking=true)
  // Premium 必須なので、Free アカウントだと false。MUSIC ボタンの disable に使う。
  const [spotifyApiWorking, setSpotifyApiWorking] = useState<boolean>(true);

  // TTS が「実際に到達可能」かを判定 (= 未設定 or 接続失敗なら SLEEP 無効化)。
  // 接続テストは時間かかるので、結果を localStorage に 5 分キャッシュ。
  // 設定保存 / 接続テスト時は CustomEvent でキャッシュ無効化 + 即時再評価。
  useEffect(() => {
    const CACHE_KEY = "vroid-tts-status";
    const CACHE_TTL_MS = 5 * 60_000;
    let active = true;

    const runCheck = async () => {
      // (1) URL 設定の有無を先に確認 (= 空欄なら ping せず即無効化)
      let urlSet = false;
      try {
        const res = await fetch("/api/ai-settings");
        if (res.ok) {
          const j = (await res.json()) as { settings?: { tts_url?: string } };
          urlSet = !!j.settings?.tts_url && j.settings.tts_url.trim().length > 0;
        }
      } catch {
        /* noop */
      }

      if (!urlSet) {
        if (active) setTtsEnabled(false);
        // 失敗はキャッシュしない (= URL 入れ直したら次のリロードで即 ping)
        try { window.localStorage.removeItem(CACHE_KEY); } catch { /* noop */ }
        return;
      }

      // (2) 接続テスト (= 既存の test endpoint を叩く、6s timeout)
      let pingOk = false;
      try {
        const res = await fetch("/api/ai-settings/test/tts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
          signal: AbortSignal.timeout(6000),
        });
        if (res.ok) {
          const j = (await res.json()) as { ok?: boolean };
          pingOk = !!j.ok;
        }
      } catch {
        /* noop — 接続失敗 = pingOk=false */
      }

      if (active) setTtsEnabled(pingOk);
      // 成功時のみキャッシュ (= 失敗はリロードのたび re-ping、URL 復活を素早く検知)
      try {
        if (pingOk) {
          window.localStorage.setItem(CACHE_KEY, JSON.stringify({ ok: true, ts: Date.now() }));
        } else {
          window.localStorage.removeItem(CACHE_KEY);
        }
      } catch { /* noop */ }
    };

    // 初期: 「成功キャッシュ」があれば即 true、それ以外は必ず ping (= 失敗状態は即時再評価)。
    // cache 部分は本来 lazy init 化できるが、ping/recheck と密接なのでここでまとめて effect 内で処理。
    let usedCache = false;
    try {
      const cached = window.localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { ok: boolean; ts: number };
        if (parsed.ok && Date.now() - parsed.ts < CACHE_TTL_MS) {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount cache hydration
          setTtsEnabled(true);
          usedCache = true;
        }
      }
    } catch { /* noop */ }
    if (!usedCache) void runCheck();

    // テスト結果が来たら直接反映 (= 再 ping 不要)
    const onStatusChange = (e: Event) => {
      const ce = e as CustomEvent<{ ok: boolean }>;
      if (active) setTtsEnabled(!!ce.detail?.ok);
    };
    // 設定保存時は cache クリアされてるので再 ping
    const onRecheck = () => {
      if (active) void runCheck();
    };
    window.addEventListener("yui-tts-status-change", onStatusChange);
    window.addEventListener("yui-tts-status-recheck", onRecheck);
    return () => {
      active = false;
      window.removeEventListener("yui-tts-status-change", onStatusChange);
      window.removeEventListener("yui-tts-status-recheck", onRecheck);
    };
  }, []);

  // Spotify Web API 接続確認 (= MUSIC ボタン disable 用)。/api/spotify/status を fetch、
  // apiWorking が true なら使える、false なら disable。
  // 結果は localStorage に短時間キャッシュ。Settings の SpotifyIntegrationSection が
  // status を更新したら yui-spotify-status-change が飛んでくるので即反映。
  useEffect(() => {
    const CACHE_KEY = "vroid-spotify-status";
    const CACHE_TTL_MS = 5 * 60_000;
    let active = true;

    const runCheck = async () => {
      try {
        const res = await fetch("/api/spotify/status", { cache: "no-store" });
        if (!res.ok) {
          if (active) setSpotifyApiWorking(false);
          return;
        }
        const data = (await res.json()) as { apiWorking?: boolean };
        const ok = !!data.apiWorking;
        if (active) setSpotifyApiWorking(ok);
        try {
          if (ok) {
            window.localStorage.setItem(
              CACHE_KEY,
              JSON.stringify({ ok: true, ts: Date.now() })
            );
          } else {
            window.localStorage.removeItem(CACHE_KEY);
          }
        } catch { /* noop */ }
      } catch {
        if (active) setSpotifyApiWorking(false);
      }
    };

    // 初期: 「成功キャッシュ」あれば即 true、それ以外は ping
    let usedCache = false;
    try {
      const cached = window.localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached) as { ok: boolean; ts: number };
        if (parsed.ok && Date.now() - parsed.ts < CACHE_TTL_MS) {
          // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount cache hydration
          setSpotifyApiWorking(true);
          usedCache = true;
        }
      }
    } catch { /* noop */ }
    if (!usedCache) void runCheck();

    const onChange = (e: Event) => {
      const ce = e as CustomEvent<{ apiWorking?: boolean }>;
      if (active) setSpotifyApiWorking(!!ce.detail?.apiWorking);
    };
    const onRecheck = () => {
      if (active) void runCheck();
    };
    window.addEventListener("yui-spotify-status-change", onChange);
    window.addEventListener("yui-spotify-status-recheck", onRecheck);
    return () => {
      active = false;
      window.removeEventListener("yui-spotify-status-change", onChange);
      window.removeEventListener("yui-spotify-status-recheck", onRecheck);
    };
  }, []);

  // localStorage の volume を mount 後に読む (SSR hydration mismatch 回避の典型パターン)。
  // mounted=true は「SSR では false で render、hydrate 後に true で再 render」の guard で、
  // 公式 React 19 docs でも mount effect 内 setState は許容される (= legitimate sync)。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setMounted(true);
    const raw =
      window.localStorage.getItem(VOLUME_STORAGE_KEY) ??
      window.localStorage.getItem(LEGACY_VOLUME_KEY);
    const v = raw == null ? 1 : Number(raw);
    setMuted(Number.isFinite(v) && v === 0);
    // 他コンポーネントからの変更を反映 (storage event は別タブのみだが念のため)
    const handler = () => {
      const r = window.localStorage.getItem(VOLUME_STORAGE_KEY);
      const vv = r == null ? 1 : Number(r);
      setMuted(Number.isFinite(vv) && vv === 0);
    };
    window.addEventListener("storage", handler);
    window.addEventListener("yui-volume-change", handler);
    return () => {
      window.removeEventListener("storage", handler);
      window.removeEventListener("yui-volume-change", handler);
    };
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  function toggleMute() {
    const readNum = (key: string, fallback: number) => {
      const r = window.localStorage.getItem(key);
      const n = r == null ? fallback : Number(r);
      return Number.isFinite(n) ? n : fallback;
    };
    const voice = readNum(VOLUME_STORAGE_KEY, readNum(LEGACY_VOLUME_KEY, 1));
    const music = readNum(MUSIC_VOLUME_KEY, 1);
    const currentlyMuted = voice === 0;

    if (currentlyMuted) {
      // 解除: pre-mute 値を読んで復元 (無ければ 1)
      const voiceRestore = readNum(PRE_MUTE_VOICE_KEY, 1);
      const musicRestore = readNum(PRE_MUTE_MUSIC_KEY, 1);
      window.localStorage.setItem(VOLUME_STORAGE_KEY, String(voiceRestore));
      window.localStorage.setItem(MUSIC_VOLUME_KEY, String(musicRestore));
      setMuted(false);
    } else {
      // ミュート: 現在の音量を退避してから 0 にする
      if (voice > 0) window.localStorage.setItem(PRE_MUTE_VOICE_KEY, String(voice));
      if (music > 0) window.localStorage.setItem(PRE_MUTE_MUSIC_KEY, String(music));
      window.localStorage.setItem(VOLUME_STORAGE_KEY, "0");
      window.localStorage.setItem(MUSIC_VOLUME_KEY, "0");
      setMuted(true);
    }
    // ChatPanel / SecretaryCard に Yui 声の変更通知 (音楽は MusicModal が
    // 別途 vroid-music-volume-change を listen する)
    window.dispatchEvent(new CustomEvent("yui-volume-change"));
    window.dispatchEvent(new CustomEvent("vroid-music-volume-change"));
  }

  // 汎用 toast helper。直近で NEWS placeholder を本物 modal に置き換えた際に唯一の
  // 呼び出し元が消えた。toasts state 自体は下の JSX に残してあるので、別ボタンが
  // 簡易フィードバックを必要になった時にここから再接続できる。
  function _showToast(text: string) {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 2500);
  }

  return (
    <>
      <div className="icon-bar" role="toolbar" aria-label="メニュー">
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenSettings?.()}
            aria-label="設定を開く"
            title="設定"
          >
            <GearIcon />
          </button>
          <span className="icon-bar-label">OPTION</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenLog?.()}
            aria-label="ログを開く"
            title="ログ (会話 / システム)"
          >
            <LogIcon />
          </button>
          <span className="icon-bar-label">LOG</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenTodo?.()}
            aria-label="TODO リスト"
            title="TODO リスト"
          >
            <TodoIcon />
          </button>
          <span className="icon-bar-label">TODO</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenProjects?.()}
            aria-label="プロジェクトハブ"
            title="プロジェクトハブ"
          >
            <ProjectsIcon />
          </button>
          <span className="icon-bar-label">PROJ</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenNotes?.()}
            aria-label="ノート"
            title="ノート"
          >
            <NotesIcon />
          </button>
          <span className="icon-bar-label">NOTES</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenCalendar?.()}
            aria-label="カレンダー"
            title="カレンダー"
          >
            <CalendarIcon />
          </button>
          <span className="icon-bar-label">予定</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenContacts?.()}
            aria-label="連絡先"
            title="連絡先"
          >
            <ContactsIcon />
          </button>
          <span className="icon-bar-label">人</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenDiary?.()}
            aria-label="日記"
            title="結衣の日記"
          >
            <DiaryIcon />
          </button>
          <span className="icon-bar-label">日記</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={onOpenNews}
            aria-label="ニュース"
            title="ニュース"
          >
            <NewsIcon />
          </button>
          <span className="icon-bar-label">NEWS</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenMail?.()}
            aria-label="メール"
            title="メール"
          >
            <MailIcon />
          </button>
          <span className="icon-bar-label">MAIL</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenMusic?.()}
            disabled={!spotifyApiWorking}
            aria-label="音楽を開く"
            title={
              spotifyApiWorking
                ? "音楽 (Spotify)"
                : "Spotify と連携 + Premium 必要 (設定 → Spotify)"
            }
          >
            <MusicIcon />
          </button>
          <span className="icon-bar-label">MUSIC</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenSleep?.()}
            disabled={!ttsEnabled}
            aria-label="睡眠サポート"
            title="睡眠サポート (認知シャッフル)"
          >
            <SleepIcon />
          </button>
          <span className="icon-bar-label">SLEEP</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenHealth?.()}
            aria-label="ヘルス"
            title="ヘルス (食事 / 体重)"
          >
            <HealthIcon />
          </button>
          <span className="icon-bar-label">HEALTH</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={() => onOpenReminders?.()}
            aria-label="リマインダー"
            title="リマインダー (予定・習慣の事前通知)"
          >
            <BellIcon />
          </button>
          <span className="icon-bar-label">REMIND</span>
        </div>
        <div className="icon-bar-item">
          <button
            type="button"
            className="icon-bar-btn"
            onClick={toggleMute}
            aria-label={muted ? "ミュート解除" : "ミュート"}
            title={muted ? "ミュート解除" : "ミュート"}
          >
            {mounted && muted ? <MuteIcon /> : <SpeakerIcon />}
          </button>
          <span className="icon-bar-label">{mounted && muted ? "OFF" : "ON"}</span>
        </div>
      </div>

      {toasts.length > 0 && (
        <div className="icon-bar-toasts" aria-live="polite">
          {toasts.map((t) => (
            <div key={t.id} className="icon-bar-toast">
              {t.text}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

/* SVG icons (inline、外部依存なし) */
function GearIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
function LogIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
function DiaryIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      <line x1="8" y1="7" x2="16" y2="7" />
      <line x1="8" y1="11" x2="14" y2="11" />
    </svg>
  );
}
function ContactsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
      <circle cx="9" cy="7" r="4" />
      <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
      <path d="M16 3.13a4 4 0 0 1 0 7.75" />
    </svg>
  );
}
function TodoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <line x1="8" y1="9" x2="16" y2="9" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="12" y2="17" />
    </svg>
  );
}
function ProjectsIcon() {
  // lucide 風 layout-grid (2x2 矩形) でプロジェクトの「複数の塊」を表現
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="3" width="7" height="7" rx="1.5" />
      <rect x="14" y="3" width="7" height="7" rx="1.5" />
      <rect x="3" y="14" width="7" height="7" rx="1.5" />
      <rect x="14" y="14" width="7" height="7" rx="1.5" />
    </svg>
  );
}

function NotesIcon() {
  // lucide 風 notebook-pen (ノート + ペン) でメモ/ノートを表現
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 6h4" />
      <path d="M2 10h4" />
      <path d="M2 14h4" />
      <path d="M2 18h4" />
      <rect width="16" height="20" x="4" y="2" rx="2" />
      <path d="M9.5 8h5" />
      <path d="M9.5 12H16" />
      <path d="M9.5 16H14" />
    </svg>
  );
}
function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <line x1="3" y1="10" x2="21" y2="10" />
      <line x1="8" y1="3" x2="8" y2="7" />
      <line x1="16" y1="3" x2="16" y2="7" />
    </svg>
  );
}
function NewsIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
      <path d="M18 14h-8M15 18h-5M10 6h8v4h-8z" />
    </svg>
  );
}
function MailIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="M3 7l9 6 9-6" />
    </svg>
  );
}
function HealthIcon() {
  // lucide "activity" 風: 1 ストロークの心電図波形
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  );
}

function BellIcon() {
  // lucide "bell-ring" — リマインダー
  return (
    <svg
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
      <path d="M4 2C2.8 3.7 2 5.7 2 8" />
      <path d="M22 8c0-2.3-.8-4.3-2-6" />
    </svg>
  );
}

function MusicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V5l12-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="18" cy="16" r="3" />
    </svg>
  );
}
function SleepIcon() {
  // lucide moon: 三日月 (currentColor + stroke、他のアイコンと同じ流儀)
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
    </svg>
  );
}
function SpeakerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4z" />
      <path d="M19.07 4.93a10 10 0 010 14.14" />
      <path d="M15.54 8.46a5 5 0 010 7.07" />
    </svg>
  );
}
function MuteIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 5L6 9H2v6h4l5 4z" />
      <line x1="22" y1="9" x2="16" y2="15" />
      <line x1="16" y1="9" x2="22" y2="15" />
    </svg>
  );
}
