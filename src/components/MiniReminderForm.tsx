"use client";

/**
 * リマインダー作成 / 編集用 form (= popup 内に置く)。
 * RemindersModal / TodoModal / CalendarModal から共用。
 *
 * - 新規時: initial を渡さず onSaved(created) を受ける
 * - 編集時: initial に既存 reminder を渡し、onSaved(updated) を受ける
 */
import { useState, type FormEvent } from "react";

export type ReminderKind = "habit" | "todo_due" | "event_due" | "custom";
export type ScheduleKind = "once" | "weekly";

export type ReminderInitial = {
  id?: number;
  kind?: ReminderKind;
  title?: string;
  extraPrompt?: string | null;
  scheduleKind?: ScheduleKind;
  baseAt?: string | null;     // ISO (once 用)
  baseTime?: string | null;   // "HH:MM" (weekly 用)
  weekdays?: number[];
  leadMinutes?: number;
  refTable?: string | null;
  refId?: number | null;
};

type Props = {
  sessionId: string;
  initial?: ReminderInitial;
  /** TODO/Calendar 連携で pre-fill する時、UI で kind / schedule_kind / base_at を固定したい場合 */
  lockKind?: ReminderKind;
  lockScheduleKind?: ScheduleKind;
  onSaved?: (saved: { id: number }) => void;
  onCancel: () => void;
};

const LEAD_PRESETS = [
  { label: "同時刻", value: 0 },
  { label: "5 分前", value: 5 },
  { label: "30 分前", value: 30 },
  { label: "1 時間前", value: 60 },
  { label: "1 日前", value: 1440 },
];

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export default function MiniReminderForm({
  sessionId,
  initial,
  lockKind,
  lockScheduleKind,
  onSaved,
  onCancel,
}: Props) {
  const isEdit = initial?.id !== undefined;
  const [kind, setKind] = useState<ReminderKind>(initial?.kind ?? lockKind ?? "custom");
  const [title, setTitle] = useState<string>(initial?.title ?? "");
  const [extraPrompt, setExtraPrompt] = useState<string>(initial?.extraPrompt ?? "");
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(
    initial?.scheduleKind ?? lockScheduleKind ?? "once"
  );
  // datetime-local 入力用 (= "YYYY-MM-DDTHH:MM" JST)
  const [baseAtLocal, setBaseAtLocal] = useState<string>(
    initial?.baseAt ? isoToLocalInput(initial.baseAt) : ""
  );
  const [baseTime, setBaseTime] = useState<string>(initial?.baseTime ?? "08:00");
  const [weekdays, setWeekdays] = useState<number[]>(initial?.weekdays ?? []);
  const [leadMinutes, setLeadMinutes] = useState<number>(initial?.leadMinutes ?? 0);
  const [customLeadOpen, setCustomLeadOpen] = useState<boolean>(
    !!initial?.leadMinutes && !LEAD_PRESETS.some((p) => p.value === initial?.leadMinutes)
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!title.trim()) {
      setError("タイトルを入力してください");
      return;
    }
    let schedule;
    if (scheduleKind === "once") {
      if (!baseAtLocal) {
        setError("日時を入力してください");
        return;
      }
      const baseAt = localInputToIso(baseAtLocal);
      schedule = { kind: "once" as const, baseAt, leadMinutes };
    } else {
      if (!/^\d{2}:\d{2}$/.test(baseTime)) {
        setError("時刻は HH:MM 形式で入力してください");
        return;
      }
      schedule = {
        kind: "weekly" as const,
        baseTime,
        weekdays,
        leadMinutes,
      };
    }

    setSaving(true);
    try {
      const body: Record<string, unknown> = {
        sessionId,
        kind,
        title: title.trim(),
        extraPrompt: extraPrompt.trim() || null,
        schedule,
      };
      if (initial?.refTable) body.refTable = initial.refTable;
      if (initial?.refId !== undefined && initial?.refId !== null) body.refId = initial.refId;

      let res: Response;
      if (isEdit) {
        res = await fetch(`/api/reminders/${initial!.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: title.trim(),
            extraPrompt: extraPrompt.trim() || null,
            schedule,
          }),
        });
      } else {
        res = await fetch(`/api/reminders`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
      }
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const j = (await res.json()) as { id: number };
      onSaved?.({ id: j.id });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const toggleWeekday = (w: number) => {
    setWeekdays((prev) =>
      prev.includes(w) ? prev.filter((x) => x !== w) : [...prev, w].sort()
    );
  };

  return (
    <form className="reminder-form" onSubmit={submit}>
      <div className="reminder-form-row">
        <label>タイトル</label>
        <input
          name="mini-reminder-title"
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="ジム / 薬 (朝) / 若園さんとランチ"
          maxLength={120}
          autoFocus
        />
      </div>

      {!lockKind && (
        <div className="reminder-form-row">
          <label>種類</label>
          <select value={kind} onChange={(e) => setKind(e.target.value as ReminderKind)}>
            <option value="habit">習慣 (繰り返し)</option>
            <option value="todo_due">TODO 期限</option>
            <option value="event_due">予定の前通知</option>
            <option value="custom">その他</option>
          </select>
        </div>
      )}

      {!lockScheduleKind && (
        <div className="reminder-form-row">
          <label>スケジュール</label>
          <div className="reminder-form-segmented">
            <button
              type="button"
              className={scheduleKind === "once" ? "active" : ""}
              onClick={() => setScheduleKind("once")}
            >
              単発
            </button>
            <button
              type="button"
              className={scheduleKind === "weekly" ? "active" : ""}
              onClick={() => setScheduleKind("weekly")}
            >
              繰り返し
            </button>
          </div>
        </div>
      )}

      {scheduleKind === "once" ? (
        <div className="reminder-form-row">
          <label>ベース日時</label>
          <input
            name="mini-reminder-base-datetime"
            type="datetime-local"
            value={baseAtLocal}
            onChange={(e) => setBaseAtLocal(e.target.value)}
          />
        </div>
      ) : (
        <>
          <div className="reminder-form-row">
            <label>ベース時刻</label>
            <input
              name="mini-reminder-base-time"
              type="time"
              value={baseTime}
              onChange={(e) => setBaseTime(e.target.value)}
            />
          </div>
          <div className="reminder-form-row">
            <label>曜日</label>
            <div className="reminder-form-weekdays">
              {WEEKDAY_LABELS.map((lbl, idx) => (
                <button
                  type="button"
                  key={idx}
                  className={`reminder-form-weekday ${weekdays.includes(idx) ? "active" : ""}`}
                  onClick={() => toggleWeekday(idx)}
                  title={lbl + "曜"}
                >
                  {lbl}
                </button>
              ))}
              <span className="reminder-form-weekday-hint">
                {weekdays.length === 0 ? "(空 = 毎日)" : ""}
              </span>
            </div>
          </div>
        </>
      )}

      <div className="reminder-form-row">
        <label>リマインド</label>
        <div className="reminder-form-lead">
          {LEAD_PRESETS.map((p) => (
            <button
              type="button"
              key={p.value}
              className={`reminder-form-chip ${leadMinutes === p.value && !customLeadOpen ? "active" : ""}`}
              onClick={() => {
                setLeadMinutes(p.value);
                setCustomLeadOpen(false);
              }}
            >
              {p.label}
            </button>
          ))}
          <button
            type="button"
            className={`reminder-form-chip ${customLeadOpen ? "active" : ""}`}
            onClick={() => setCustomLeadOpen(true)}
          >
            カスタム
          </button>
          {customLeadOpen && (
            <input
              name="mini-reminder-lead-minutes"
              type="number"
              min={0}
              value={leadMinutes}
              onChange={(e) => setLeadMinutes(Math.max(0, parseInt(e.target.value || "0", 10)))}
              className="reminder-form-lead-input"
            />
          )}
          <span className="reminder-form-lead-hint">分前</span>
        </div>
      </div>

      <details className="reminder-form-extra">
        <summary>追加指示 (任意)</summary>
        <textarea
          name="mini-reminder-extra-prompt"
          value={extraPrompt}
          onChange={(e) => setExtraPrompt(e.target.value)}
          placeholder="ゆいへの追加指示。例: '朝の分まだなら飲むよう促して'"
          rows={2}
        />
      </details>

      {error && <div className="reminder-form-error">{error}</div>}

      <div className="reminder-form-actions">
        <button type="button" className="confirm-cancel-btn" onClick={onCancel} disabled={saving}>
          キャンセル
        </button>
        <button type="submit" className="todo-add-btn" disabled={saving}>
          {saving ? "保存中…" : isEdit ? "更新" : "作成"}
        </button>
      </div>
    </form>
  );
}

// ───── helpers ─────

/** "2026-06-05T13:00:00+09:00" → "2026-06-05T13:00" (datetime-local 用) */
function isoToLocalInput(iso: string): string {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    // JST 表示用に Intl で組み立てる
    const parts = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
  } catch {
    return "";
  }
}

/** "2026-06-05T13:00" (datetime-local) → "2026-06-05T13:00:00+09:00" */
function localInputToIso(local: string): string {
  // datetime-local は無 TZ なので、JST として解釈する
  if (!local) return new Date().toISOString();
  return `${local}:00+09:00`;
}
