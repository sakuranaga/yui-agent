"use client";

/**
 * リマインダー一覧モーダル。
 * - IconBar の REMIND ボタンから開く
 * - 一覧 (有効 / 無効化済 含む切替) + 新規追加 + 編集 popup + 削除
 *
 * 設計: docs/reminders-system.md §5
 */
import { useCallback, useEffect, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";
import MiniReminderForm, { type ReminderInitial } from "@/components/MiniReminderForm";

type ReminderRow = {
  id: number;
  session_id: string;
  kind: "habit" | "todo_due" | "event_due" | "custom";
  title: string;
  extra_prompt: string | null;
  schedule:
    | { kind: "once"; baseAt: string; leadMinutes: number }
    | { kind: "weekly"; baseTime: string; weekdays: number[]; leadMinutes: number };
  ref_table: string | null;
  ref_id: number | null;
  enabled: boolean;
  last_fired_at: string | null;
  next_due_at: string | null;
  fire_count: number;
};

type Props = {
  open: boolean;
  onClose: () => void;
  sessionId: string;
};

const KIND_LABEL: Record<ReminderRow["kind"], string> = {
  habit: "習慣",
  todo_due: "TODO 期限",
  event_due: "予定の前通知",
  custom: "その他",
};

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export default function RemindersModal({ open, onClose, sessionId }: Props) {
  const { mounted, closing } = useModalTransition(open);
  const [rows, setRows] = useState<ReminderRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<ReminderRow | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) return;
    setLoading(true);
    try {
      const q = new URLSearchParams({ session: sessionId });
      if (!includeDisabled) q.set("enabled", "true");
      const res = await fetch(`/api/reminders?${q.toString()}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const j = (await res.json()) as { reminders: ReminderRow[] };
      setRows(j.reminders);
    } catch (e) {
      console.warn("[reminders] list failed:", e);
    } finally {
      setLoading(false);
    }
  }, [sessionId, includeDisabled]);

  useEffect(() => {
    // modal open 時に reminder 一覧を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    if (open) void refresh();
  }, [open, refresh]);

  const toggleEnabled = async (r: ReminderRow) => {
    try {
      const res = await fetch(`/api/reminders/${r.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !r.enabled }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      console.warn("[reminders] toggle failed:", e);
    }
  };

  const remove = async (r: ReminderRow) => {
    if (!confirm(`「${r.title}」を削除しますか?`)) return;
    try {
      const res = await fetch(`/api/reminders/${r.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      await refresh();
    } catch (e) {
      console.warn("[reminders] delete failed:", e);
    }
  };

  if (!mounted) return null;

  return (
    <div
      className={`reminders-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`reminders-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="reminders-modal-title"
      >
        <button
          type="button"
          className="reminders-modal-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <header className="reminders-modal-header">
          <h1 id="reminders-modal-title">リマインダー</h1>
          <div className="reminders-modal-actions">
            <label className="reminders-toggle">
              <input
                type="checkbox"
                checked={includeDisabled}
                onChange={(e) => setIncludeDisabled(e.target.checked)}
              />
              <span>停止中も表示</span>
            </label>
            <button
              type="button"
              className="todo-add-btn"
              onClick={() => setCreating(true)}
            >
              + 新規追加
            </button>
          </div>
        </header>

        <div className="reminders-modal-body">
          {loading && rows.length === 0 ? (
            <div className="reminders-empty">読み込み中…</div>
          ) : rows.length === 0 ? (
            <div className="reminders-empty">
              リマインダーはまだありません。
              <br />
              「+ 新規追加」 か、ご主人様の発話 (例: 「毎週月曜 19 時にジム」) でゆいが作ります。
            </div>
          ) : (
            <ul className="reminders-list">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className={`reminders-row ${r.enabled ? "" : "disabled"}`}
                >
                  <button
                    type="button"
                    className="reminders-row-body"
                    onClick={() => setEditing(r)}
                  >
                    <div className="reminders-row-head">
                      <span className="reminders-row-kind">{KIND_LABEL[r.kind]}</span>
                      <span className="reminders-row-title">{r.title}</span>
                    </div>
                    <div className="reminders-row-meta">
                      <span className="reminders-row-schedule">{formatSchedule(r.schedule)}</span>
                      {r.next_due_at && (
                        <span className="reminders-row-next">次回: {formatJst(r.next_due_at)}</span>
                      )}
                      {r.last_fired_at && (
                        <span className="reminders-row-last">最終: {formatJst(r.last_fired_at)}</span>
                      )}
                      {r.ref_table === "todos" && (
                        <span className="reminders-row-ref">→ TODO #{r.ref_id}</span>
                      )}
                    </div>
                  </button>
                  <div className="reminders-row-controls">
                    <button
                      type="button"
                      className="reminder-btn ghost small"
                      onClick={() => toggleEnabled(r)}
                      title={r.enabled ? "停止" : "再開"}
                    >
                      {r.enabled ? "停止" : "再開"}
                    </button>
                    <button
                      type="button"
                      className="reminder-btn danger small"
                      onClick={() => remove(r)}
                      title="削除"
                    >
                      削除
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>

        {creating && (
          <div className="reminder-popup-backdrop" onClick={() => setCreating(false)}>
            <div className="reminder-popup" onClick={(e) => e.stopPropagation()}>
              <header className="reminder-popup-header">
                <h2>新規リマインダー</h2>
              </header>
              <MiniReminderForm
                sessionId={sessionId}
                onCancel={() => setCreating(false)}
                onSaved={async () => {
                  setCreating(false);
                  await refresh();
                }}
              />
            </div>
          </div>
        )}

        {editing && (
          <div className="reminder-popup-backdrop" onClick={() => setEditing(null)}>
            <div className="reminder-popup" onClick={(e) => e.stopPropagation()}>
              <header className="reminder-popup-header">
                <h2>リマインダー編集</h2>
              </header>
              <MiniReminderForm
                sessionId={sessionId}
                initial={rowToInitial(editing)}
                onCancel={() => setEditing(null)}
                onSaved={async () => {
                  setEditing(null);
                  await refresh();
                }}
              />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function rowToInitial(r: ReminderRow): ReminderInitial {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    extraPrompt: r.extra_prompt,
    scheduleKind: r.schedule.kind,
    baseAt: r.schedule.kind === "once" ? r.schedule.baseAt : null,
    baseTime: r.schedule.kind === "weekly" ? r.schedule.baseTime : null,
    weekdays: r.schedule.kind === "weekly" ? r.schedule.weekdays : [],
    leadMinutes: r.schedule.leadMinutes,
    refTable: r.ref_table,
    refId: r.ref_id,
  };
}

function formatSchedule(s: ReminderRow["schedule"]): string {
  if (s.kind === "once") {
    const dt = formatJst(s.baseAt);
    const lead = s.leadMinutes > 0 ? ` (${formatLead(s.leadMinutes)}前)` : "";
    return `${dt}${lead}`;
  }
  const wd =
    s.weekdays.length === 0 || s.weekdays.length === 7
      ? "毎日"
      : s.weekdays.map((w) => WEEKDAY_LABELS[w]).join("");
  const lead = s.leadMinutes > 0 ? ` (${formatLead(s.leadMinutes)}前)` : "";
  return `${wd} ${s.baseTime}${lead}`;
}

function formatLead(min: number): string {
  if (min < 60) return `${min} 分`;
  if (min < 1440) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    return m === 0 ? `${h} 時間` : `${h}時間${m}分`;
  }
  const d = Math.floor(min / 1440);
  return `${d} 日`;
}

function formatJst(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  } catch {
    return iso;
  }
}
