"use client";

/**
 * 日記モーダル — 最新の 1 件を大きく表示し、< 日付 > で前後の日記に切替。
 * スタイルは TodoModal と同じ game-style (オフホワイト額縁 + 円形 close)。
 */
import { useCallback, useEffect, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";

type DiaryEntry = {
  id: number;
  entry_date: string; // YYYY-MM-DD
  body: string;
  /** TTS 正規化済み本文 (§7.8 で埋まる予定)。読み上げ時に優先利用。 */
  body_tts: string | null;
  mood: string | null;
  generated_at: string;
  model_used: string | null;
};

type ProfileSnapshot = {
  id: number;
  snapshotDate: string;
  personality: string;
  communicationStyle: string;
  currentFocus: string;
  moodTrend: string;
  inferredTraits: string;
  evidenceNotes: string | null;
  inferredImagePrompt: string | null;
  generatedAt: string;
  generatedBy: string;
};

const MOOD_LABEL: Record<string, string> = {
  happy: "嬉しい",
  calm: "穏やか",
  excited: "興奮",
  melancholic: "しんみり",
};

function fmtDateJa(s: string): string {
  // s は YYYY-MM-DD or ISO
  const ymd = s.length >= 10 ? s.slice(0, 10) : s;
  const d = new Date(`${ymd}T00:00:00.000+09:00`);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(d);
}

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function DiaryModal({ open, onClose }: Props) {
  const [entries, setEntries] = useState<DiaryEntry[]>([]);
  const [tab, setTab] = useState<"diary" | "profile">(() => {
    if (typeof window === "undefined") return "diary";
    return (window.localStorage.getItem("diary-modal-tab") as "diary" | "profile") || "diary";
  });
  const [profile, setProfile] = useState<ProfileSnapshot | null>(null);
  const [profileBusy, setProfileBusy] = useState(false);
  const setTabPersist = (t: "diary" | "profile") => {
    setTab(t);
    if (typeof window !== "undefined") window.localStorage.setItem("diary-modal-tab", t);
  };
  const [index, setIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [speaking, setSpeaking] = useState(false);

  const reload = useCallback(async (preserveDate?: string) => {
    setLoading(true);
    try {
      // cache: "no-store" + cache buster クエリで、書き直し直後の再 fetch が
      // 旧バイトを返さないようにする (fetch / Next.js fetch のどちらが噛んでも回避)
      const res = await fetch(`/api/diary?limit=200&t=${Date.now()}`, {
        cache: "no-store",
      });
      if (!res.ok) return;
      const data = (await res.json()) as { entries: DiaryEntry[] };
      const list = data.entries ?? [];
      setEntries(list);
      if (preserveDate) {
        const found = list.findIndex((e) => e.entry_date.slice(0, 10) === preserveDate);
        setIndex(found >= 0 ? found : 0);
      } else {
        setIndex(0); // 最新
      }
    } catch (e) {
      console.warn("diary load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    void reload();
  }, [open, reload]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") setIndex((i) => Math.min(entries.length - 1, i + 1));
      else if (e.key === "ArrowRight") setIndex((i) => Math.max(0, i - 1));
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, entries.length]);

  const regenerate = async (date: string) => {
    setRegenerating(date);
    try {
      const res = await fetch(`/api/diary/${date}/regenerate`, { method: "POST" });
      if (res.ok) await reload(date);
    } catch (e) {
      console.warn("regenerate failed:", e);
    } finally {
      setRegenerating(null);
    }
  };

  type SpeakWindow = Window & {
    __yuiSpeakText?: (text: string) => Promise<void>;
    __yuiSpeakCancel?: () => void;
  };

  const startSpeak = async () => {
    const entry = entries[index];
    // 読み上げは body_tts (TTS 正規化済) があればそちらを優先、無ければ生 body。
    const text = (entry?.body_tts ?? entry?.body ?? "").trim();
    if (!text) return;
    setSpeaking(true);
    try {
      await (window as SpeakWindow).__yuiSpeakText?.(text);
    } catch (e) {
      console.warn("[diary] speak failed:", e);
    } finally {
      setSpeaking(false);
    }
  };

  const stopSpeak = () => {
    (window as SpeakWindow).__yuiSpeakCancel?.();
    setSpeaking(false);
  };

  // 別の日記に切り替えた / モーダルを閉じた時は読み上げを止める。
  // stopSpeak は setState を含むが、event-handler-like な cleanup 用途で cascade ではない。
  /* eslint-disable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */
  useEffect(() => {
    if (!open && speaking) stopSpeak();
  }, [open]);
  useEffect(() => {
    if (speaking) stopSpeak();
  }, [index]);
  /* eslint-enable react-hooks/set-state-in-effect, react-hooks/exhaustive-deps */

  const writeToday = async () => {
    const today = new Date();
    const fmt = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = fmt.formatToParts(today);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    const dateStr = `${get("year")}-${get("month")}-${get("day")}`;
    await regenerate(dateStr);
  };

  // 現在表示中の entry に対応する profile を fetch
  const currentDate = entries[index]?.entry_date?.slice(0, 10) ?? null;
  useEffect(() => {
    if (!open || !currentDate) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear-on-close/no-date
      setProfile(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(`/api/profile-snapshots/${currentDate}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { snapshot: ProfileSnapshot | null };
        if (!cancelled) setProfile(data.snapshot);
      } catch (e) {
        console.warn("[diary-modal] profile fetch failed:", e);
      }
    })();
    return () => { cancelled = true; };
  }, [open, currentDate]);

  const regenerateProfile = async () => {
    if (!currentDate) return;
    setProfileBusy(true);
    try {
      const res = await fetch(`/api/profile-snapshots/regenerate?date=${currentDate}`, {
        method: "POST",
      });
      if (res.ok) {
        const data = (await res.json()) as { snapshot: ProfileSnapshot };
        setProfile(data.snapshot);
      }
    } finally {
      setProfileBusy(false);
    }
  };

  const { mounted, closing } = useModalTransition(open);
  if (!mounted) return null;

  const current = entries[index] ?? null;
  const canNewer = index > 0;          // > は 1 つ新しい方へ (index-1)
  const canOlder = index < entries.length - 1; // < は 1 つ古い方へ (index+1)

  return (
    <div
      className={`diary-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`diary-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="diary-modal-title"
      >
        <button
          type="button"
          className="diary-modal-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <header className="diary-modal-header">
          <h1 id="diary-modal-title">結衣の日記</h1>
          <div className="diary-modal-actions">
            <button
              type="button"
              className={`todo-add-btn ${speaking ? "diary-stop-btn" : ""}`}
              onClick={() => (speaking ? stopSpeak() : void startSpeak())}
              disabled={!entries[index]?.body || regenerating !== null}
              title={speaking ? "読み上げを停止" : "結衣に読み上げてもらう"}
            >
              {speaking ? (
                <>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <rect x="6" y="5" width="4" height="14" rx="1" />
                    <rect x="14" y="5" width="4" height="14" rx="1" />
                  </svg>
                  停止
                </>
              ) : (
                <>
                  <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true">
                    <polygon points="6 4 20 12 6 20" />
                  </svg>
                  読み上げ
                </>
              )}
            </button>
            <button
              type="button"
              className="todo-add-btn"
              onClick={() => void writeToday()}
              disabled={regenerating !== null}
            >
              今日の分を書く
            </button>
          </div>
        </header>

        <nav className="diary-nav" aria-label="日記ナビ">
          <button
            type="button"
            className="diary-nav-btn"
            onClick={() => setIndex((i) => Math.min(entries.length - 1, i + 1))}
            disabled={!canOlder}
            aria-label="前の日記"
            title="前の日記"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div className="diary-nav-date">
            {current ? fmtDateJa(current.entry_date) : "—"}
            {entries.length > 0 && (
              <span className="diary-nav-index">
                {index + 1} / {entries.length}
              </span>
            )}
          </div>
          <button
            type="button"
            className="diary-nav-btn"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={!canNewer}
            aria-label="次の日記"
            title="次の日記"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </nav>

        <div className="diary-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "diary"}
            className={`diary-tab${tab === "diary" ? " active" : ""}`}
            onClick={() => setTabPersist("diary")}
          >日記 (結衣の内面)</button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "profile"}
            className={`diary-tab${tab === "profile" ? " active" : ""}`}
            onClick={() => setTabPersist("profile")}
          >ご主人様プロファイル</button>
        </div>

        <div className="diary-body-wrap">
          {tab === "diary" ? (
            <>
              {loading && entries.length === 0 && (
                <div className="diary-loading">読み込み中…</div>
              )}
              {!loading && entries.length === 0 && (
                <div className="diary-empty">
                  日記がまだありません。深夜 23 時に自動生成されるか、「今日の分を書く」で生成できます。
                </div>
              )}
              {current && (
                <article className="diary-entry">
                  {current.mood && (
                    <div className="diary-mood">
                      {MOOD_LABEL[current.mood] ?? current.mood}
                    </div>
                  )}
                  <div className="diary-body">{current.body}</div>
                  <div className="diary-foot">
                    <span className="diary-foot-meta">
                      生成: {new Date(current.generated_at).toLocaleString("ja-JP")}
                    </span>
                    <button
                      type="button"
                      className="settings-btn"
                      onClick={() => void regenerate(current.entry_date.slice(0, 10))}
                      disabled={regenerating !== null}
                    >
                      {regenerating === current.entry_date.slice(0, 10)
                        ? "書き直し中…"
                        : "書き直す"}
                    </button>
                  </div>
                </article>
              )}
            </>
          ) : (
            <article className="profile-pane">
              {profile === null && currentDate && (
                <div className="diary-empty">
                  この日の客観プロファイルはまだ生成されていません。
                  日次 cron が JST 22 時以降に書きます。今すぐ作る場合は下記ボタン。
                </div>
              )}
              {!currentDate && (
                <div className="diary-empty">日付を選択してください。</div>
              )}
              {profile && (
                <div className="profile-fields">
                  <ProfileField label="性格" body={profile.personality} />
                  <ProfileField label="話法傾向" body={profile.communicationStyle} />
                  <ProfileField label="直近の関心" body={profile.currentFocus} />
                  <ProfileField label="気分・体調の流れ" body={profile.moodTrend} />
                  <ProfileField label="推測される追加特性" body={profile.inferredTraits} />
                  {profile.evidenceNotes && (
                    <details className="profile-evidence">
                      <summary>根拠 notes</summary>
                      <p>{profile.evidenceNotes}</p>
                    </details>
                  )}
                </div>
              )}
              <div className="profile-foot">
                <span className="profile-foot-note">
                  ※ AI による行動データの解釈です。実際のお気持ちと異なる場合があります。
                </span>
                {currentDate && (
                  <button
                    type="button"
                    className="settings-btn"
                    onClick={() => void regenerateProfile()}
                    disabled={profileBusy}
                  >
                    {profileBusy ? "生成中…" : profile ? "再生成" : "今すぐ生成"}
                  </button>
                )}
              </div>
            </article>
          )}
        </div>
      </div>
    </div>
  );
}

function ProfileField({ label, body }: { label: string; body: string }) {
  return (
    <section className="profile-field">
      <h3 className="profile-field-label">{label}</h3>
      <p className="profile-field-body">{body}</p>
    </section>
  );
}
