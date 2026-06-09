"use client";

/**
 * 秘書 (Yui) のステータスカード。chat-panel の真上に float。
 *
 * 表示要素:
 *  - 1 段目: アバターアイコン + 秘書名 (persona_settings 由来) + Lv バッジ
 *  - 2 段目: XP プログレスバー + 「N / M XP」
 *  - 3 段目: お給料 (今月⇄累計トグル) + ハート総数
 *  - 4 段目: 音量スライダー (chat-header から移植、ChatPanel の gain と localStorage で連動)
 *
 * データ層:
 *  - 初期 fetch: GET /api/secretary/stats
 *  - リアルタイム: SSE /api/chat/stream の "stats_update" event で再 fetch
 */
import { useCallback, useEffect, useRef, useState } from "react";

type Stats = {
  name: string;
  level: number;
  xpInCurrentLevel: number;
  xpForNextLevel: number;
  totalXp: number;
  salaryJpyTotal: number;
  salaryJpyMonth: number;
  heartCount: number;
};

const SESSION_STORAGE_KEY = "vroid-chat-session-id";
// Yui の声 (TTS) 専用音量。音楽は MusicModal で独立制御。
const VOLUME_STORAGE_KEY = "vroid-yui-voice-volume";
const LEGACY_VOLUME_KEY = "vroid-chat-volume";
const SALARY_MODE_KEY = "vroid-secretary-salary-mode";

function readVolume(): number {
  if (typeof window === "undefined") return 1;
  const raw =
    window.localStorage.getItem(VOLUME_STORAGE_KEY) ??
    window.localStorage.getItem(LEGACY_VOLUME_KEY);
  if (raw == null) return 1;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 1;
}

function readSalaryMode(): "month" | "total" {
  if (typeof window === "undefined") return "month";
  const raw = window.localStorage.getItem(SALARY_MODE_KEY);
  return raw === "total" ? "total" : "month";
}

type UserState = "online" | "away" | "focus" | "private";

function readUserState(): UserState {
  if (typeof window === "undefined") return "online";
  const raw = window.localStorage.getItem("vroid-user-state");
  if (raw === "online" || raw === "away" || raw === "focus" || raw === "private") return raw;
  return "online";
}

export default function SecretaryCard() {
  const [stats, setStats] = useState<Stats | null>(null);
  // localStorage 読み出しは SSR セーフな getter なので lazy init で取り込む。
  const [salaryMode, setSalaryMode] = useState<"month" | "total">(() => readSalaryMode());
  const [volume, setVolume] = useState<number>(() => readVolume());
  const [userState, setUserState] = useState<UserState>(() => readUserState());
  const esRef = useRef<EventSource | null>(null);

  // ChatPanel ヘッダの状態 popover と連動: yui-user-state イベントを受けてドット色変更。
  // 初期値は上の lazy init で取り込み済み、ここは subscribe のみ。
  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<{ state: UserState }>).detail;
      if (d?.state) setUserState(d.state);
    };
    window.addEventListener("yui-user-state", onChange);
    return () => window.removeEventListener("yui-user-state", onChange);
  }, []);

  const reload = useCallback(async () => {
    try {
      const res = await fetch("/api/secretary/stats");
      if (!res.ok) return;
      setStats((await res.json()) as Stats);
    } catch (e) {
      console.warn("[secretary-card] reload failed:", e);
    }
  }, []);

  // 初期 mount: 初回 stats fetch + SSE 接続。volume / salary mode は lazy init 済み。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();

    const sid =
      window.localStorage.getItem(SESSION_STORAGE_KEY) ?? "card-no-session";
    const es = new EventSource(
      `/api/chat/stream?session=${encodeURIComponent(sid)}`
    );
    esRef.current = es;
    const onStats = () => void reload();
    es.addEventListener("stats_update", onStats);
    return () => {
      es.removeEventListener("stats_update", onStats);
      es.close();
      esRef.current = null;
    };
  }, [reload]);

  // 音量変更時: localStorage 書き込み + ChatPanel に通知 (gain node 反映)
  const handleVolumeChange = (v: number) => {
    setVolume(v);
    window.localStorage.setItem(VOLUME_STORAGE_KEY, String(v));
    window.dispatchEvent(new CustomEvent("yui-volume-change"));
  };

  const toggleSalaryMode = () => {
    setSalaryMode((m) => {
      const next = m === "month" ? "total" : "month";
      window.localStorage.setItem(SALARY_MODE_KEY, next);
      return next;
    });
  };

  const pct =
    stats && stats.xpForNextLevel > 0
      ? Math.min(100, (stats.xpInCurrentLevel / stats.xpForNextLevel) * 100)
      : stats && stats.xpForNextLevel === 0
        ? 100
        : 0;

  const salary =
    salaryMode === "month"
      ? stats?.salaryJpyMonth ?? 0
      : stats?.salaryJpyTotal ?? 0;

  return (
    <div className="secretary-card" role="region" aria-label="秘書ステータス">
      <div className="sc-row sc-row-top">
        <span
          className={`sc-status-dot sc-status-${userState}`}
          aria-label={`ステータス: ${
            userState === "online" ? "オンライン" :
            userState === "away" ? "離席中" :
            userState === "private" ? "プライベート" : "集中モード"
          }`}
          title={`ステータス: ${
            userState === "online" ? "オンライン" :
            userState === "away" ? "離席中" :
            userState === "private" ? "プライベート" : "集中モード"
          }`}
        />
        <span className="sc-name">{stats?.name ?? "—"}</span>
        <span className="sc-lv-badge">Lv.{stats?.level ?? "—"}</span>
      </div>

      <div className="sc-xp">
        <div className="sc-xp-bar">
          <div className="sc-xp-fill" style={{ width: `${pct}%` }} />
        </div>
        <span className="sc-xp-text">
          {stats
            ? stats.xpForNextLevel > 0
              ? `${Math.floor(stats.xpInCurrentLevel)} / ${stats.xpForNextLevel} XP`
              : "MAX"
            : "—"}
        </span>
      </div>

      <div className="sc-row sc-row-stats">
        <button
          type="button"
          className="sc-salary"
          onClick={toggleSalaryMode}
          title={salaryMode === "month" ? "累計に切替" : "今月に切替"}
        >
          <span className="sc-stat-label">
            お給料 ({salaryMode === "month" ? "今月" : "累計"})
          </span>
          <span className="sc-stat-value">¥{salary.toLocaleString()}</span>
        </button>
        <div className="sc-heart" aria-label={`ハート ${stats?.heartCount ?? 0}`}>
          <HeartIcon />
          <span className="sc-stat-value">{stats?.heartCount ?? 0}</span>
        </div>
      </div>

      <div className="sc-row sc-row-volume">
        <VolumeIcon />
        <input
          type="range"
          name="yui-voice-volume"
          min={0}
          max={1}
          step={0.01}
          value={volume}
          onChange={(e) => handleVolumeChange(Number(e.target.value))}
          className="sc-volume-slider"
          aria-label="音量"
        />
      </div>
    </div>
  );
}

// アイコンは IconBar のテイスト (line stroke, 2px) に合わせる
function HeartIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 21s-7-4.35-9.5-9.05C.85 8.9 2.6 5 6.5 5c2.1 0 3.6 1.2 4.5 2.7C11.9 6.2 13.4 5 15.5 5c3.9 0 5.65 3.9 4 6.95C19 16.65 12 21 12 21z" />
    </svg>
  );
}

function VolumeIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
      <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
    </svg>
  );
}
