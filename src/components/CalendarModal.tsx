"use client";

/**
 * カレンダーモーダル — game-style 月表示 + 選択日イベント一覧 + 新規/編集/削除 popup。
 * Source of Truth は Google Calendar。書き込みは primary に。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";
import ProjectChipsEditor from "./ProjectChipsEditor";
import ArtifactLinksPanel from "./ArtifactLinksPanel";
import IntentKebabMenu from "./IntentKebabMenu";
import MiniReminderForm from "./MiniReminderForm";
import WeatherIcon from "./WeatherIcon";
import type { WeatherForecastDay } from "@/lib/weather";

type CalEvent = {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  start: { dateTime?: string; date?: string; timeZone?: string };
  end: { dateTime?: string; date?: string; timeZone?: string };
  calendarId?: string;
  calendarSummary?: string;
  htmlLink?: string;
};

type DraftEvent = {
  id?: string;
  calendarId?: string;
  summary: string;
  description: string;
  location: string;
  allDay: boolean;
  startDate: string; // YYYY-MM-DD
  startTime: string; // HH:mm
  endDate: string;
  endTime: string;
};

function ymdJST(d: Date): string {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function eventStartMs(e: CalEvent): number {
  if (e.start.dateTime) return Date.parse(e.start.dateTime);
  if (e.start.date) return Date.parse(`${e.start.date}T00:00:00+09:00`);
  return 0;
}

function eventDateYmd(e: CalEvent): string {
  if (e.start.date) return e.start.date.slice(0, 10);
  if (e.start.dateTime) return ymdJST(new Date(e.start.dateTime));
  return "";
}

function fmtTime(dt?: string): string {
  if (!dt) return "";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** Intent dispatch (Mail → 予定 等) からの pre-fill。open=true 遷移時に
   *  edit popup を新規イベントモードで開いて値を流し込む。 */
  intentDraft?: {
    summary?: string;
    description?: string;
    startIso?: string;
    endIso?: string;
    location?: string;
  } | null;
  /** Intent 経路の出典 source。作成完了後に artifact_links を書く用。 */
  intentSource?: { type: string; id: string } | null;
};

const WEEKDAY_LABELS = ["日", "月", "火", "水", "木", "金", "土"];

export default function CalendarModal({ open, onClose, intentDraft, intentSource }: Props) {
  // today は JST 基準。CalendarModal は親 page で常駐 mount されているため、
  // useMemo([]) で固定すると日付が変わっても更新されない (前日のページを翌朝
  // そのまま開くと「今日」を押しても前日になる) → モーダル開閉のたび refresh する。
  const [today, setToday] = useState(() => ymdJST(new Date()));
  useEffect(() => {
    // 開閉時に「今日」を refresh (日跨ぎ対策)。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open refresh
    if (open) setToday(ymdJST(new Date()));
  }, [open]);
  const [viewYear, setViewYear] = useState(() => Number(today.slice(0, 4)));
  const [viewMonth, setViewMonth] = useState(() => Number(today.slice(5, 7))); // 1-12
  const [selectedDate, setSelectedDate] = useState<string>(today);
  const [events, setEvents] = useState<CalEvent[]>([]);
  const [editing, setEditing] = useState<DraftEvent | null>(null);
  // intent dispatch から draft が渡ってきた時、新規イベント編集 popup を pre-fill 状態で開く。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open || !intentDraft) return;
    const start = intentDraft.startIso ? new Date(intentDraft.startIso) : new Date();
    const end = intentDraft.endIso
      ? new Date(intentDraft.endIso)
      : new Date(start.getTime() + 60 * 60 * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    const yyyymmdd = (d: Date) =>
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    setEditing({
      summary: intentDraft.summary ?? "",
      description: intentDraft.description ?? "",
      location: intentDraft.location ?? "",
      allDay: false,
      startDate: yyyymmdd(start),
      startTime: hhmm(start),
      endDate: yyyymmdd(end),
      endTime: hhmm(end),
    });
  }, [open, intentDraft]);
  /* eslint-enable react-hooks/set-state-in-effect */
  const [deleting, setDeleting] = useState<CalEvent | null>(null);
  // クリックされたイベントの詳細 popup (クリック位置に表示)
  const [detail, setDetail] = useState<{ event: CalEvent; x: number; y: number } | null>(null);
  // 「他 N 件」クリックで開く、その日の全予定リスト popup
  const [dayList, setDayList] = useState<{ ymd: string; events: CalEvent[]; x: number; y: number } | null>(null);
  const [addReminderForEvent, setAddReminderForEvent] = useState<DraftEvent | null>(null);
  // sessionId は SSR セーフな lazy init で取り込む。
  const [sessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem("vroid-chat-session-id");
    } catch {
      return null;
    }
  });

  // 表示グリッド全体 (42 セル分) の範囲を取得。
  // 月初の前後に隣接月のセルが見えるので、そこに含まれる予定もまとめて取りに行く。
  // JST 1 日 0:00 = UTC 前日 15:00。
  const monthRange = useMemo(() => {
    const first = new Date(viewYear, viewMonth - 1, 1);
    const startDow = first.getDay();
    const fromDay = 1 - startDow;
    const toDay = fromDay + 42;
    const from = new Date(Date.UTC(viewYear, viewMonth - 1, fromDay, -9));
    const to = new Date(Date.UTC(viewYear, viewMonth - 1, toDay, -9));
    return { from: from.toISOString(), to: to.toISOString() };
  }, [viewYear, viewMonth]);

  const reload = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/calendar/events?from=${encodeURIComponent(monthRange.from)}&to=${encodeURIComponent(monthRange.to)}`
      );
      if (!res.ok) return;
      const data = (await res.json()) as { events: CalEvent[] };
      setEvents(data.events ?? []);
    } catch (e) {
      console.warn("[calendar] reload failed:", e);
    }
  }, [monthRange.from, monthRange.to]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    void reload();
  }, [open, reload]);

  // light theme で chip テキストを読みやすくするため、project color の RGB を一律
  // 暗くする。ビビッドな黄/水色/緑も濃いトーンになって背景の白に対してコントラスト
  // が取れる。-100 だと潰れすぎたので -60 で調整。
  // null / 空文字 / parse 失敗時は null を返して呼び出し側で色適用スキップ。
  const darkenForLight = useCallback((hex: string | null | undefined): string | null => {
    if (!hex) return null;
    const m = hex.trim().match(/^#?([0-9a-f]{3,8})$/i);
    if (!m) return null;
    let h = m[1];
    if (h.length === 3) h = h.split("").map((c) => c + c).join("");
    if (h.length < 6) return null;
    const r = Math.max(0, parseInt(h.slice(0, 2), 16) - 60);
    const g = Math.max(0, parseInt(h.slice(2, 4), 16) - 60);
    const b = Math.max(0, parseInt(h.slice(4, 6), 16) - 60);
    return `rgb(${r}, ${g}, ${b})`;
  }, []);

  // event 毎の primary project カラーを map で持つ。chip テキスト着色用。
  // events が変わるたびに 1 リクエストで batch 取得 (N+1 回避)。
  const [eventProjectColor, setEventProjectColor] = useState<Map<string, string>>(new Map());
  useEffect(() => {
    if (!open || events.length === 0) return;
    let cancelled = false;
    (async () => {
      try {
        const ids = events.map((e) => e.id).join(",");
        const res = await fetch(
          `/api/project-links?artifactType=event&artifactIds=${encodeURIComponent(ids)}`
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          byId: Record<string, Array<{ id: number; name: string; color: string | null; linkedBy: string }>>;
        };
        if (cancelled) return;
        const next = new Map<string, string>();
        for (const [eid, projs] of Object.entries(data.byId)) {
          // primary 優先 → 無ければ最初の project の color
          const primary = projs.find((p) => p.linkedBy === "primary");
          const chosen = primary ?? projs[0];
          const darkened = chosen ? darkenForLight(chosen.color) : null;
          if (darkened) next.set(eid, darkened);
        }
        setEventProjectColor(next);
      } catch (e) {
        console.warn("[calendar] project-links batch failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, events, darkenForLight]);

  // 週間天気予報 (10 日分) を取得 → 日付セル横にアイコン表示。
  // モーダル open 毎に非同期 refetch (予報は毎日変わる)。過去日は DB 凍結値。
  const [weatherByDate, setWeatherByDate] = useState<Map<string, WeatherForecastDay>>(new Map());
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/weather/forecast?days=10", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { forecast: WeatherForecastDay[] };
        if (cancelled) return;
        const m = new Map<string, WeatherForecastDay>();
        for (const d of data.forecast ?? []) m.set(d.date, d);
        setWeatherByDate(m);
      } catch (e) {
        console.warn("[calendar] weather fetch failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (detail) setDetail(null);
        else if (dayList) setDayList(null);
        else if (editing) setEditing(null);
        else if (deleting) setDeleting(null);
        else onClose();
      }
    }
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, editing, deleting, detail, dayList, onClose]);

  // 月グリッド (7 × 6 = 42 セル) を生成。月初の前後余白も含む。
  const grid = useMemo(() => {
    const first = new Date(viewYear, viewMonth - 1, 1);
    const startDow = first.getDay(); // 0 = 日
    const cells: Array<{ ymd: string; inMonth: boolean }> = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(viewYear, viewMonth - 1, 1 + (i - startDow));
      const ymd = ymdJST(d);
      cells.push({ ymd, inMonth: d.getMonth() === viewMonth - 1 });
    }
    return cells;
  }, [viewYear, viewMonth]);

  // 日付ごとの events 集計
  const eventsByDay = useMemo(() => {
    const map = new Map<string, CalEvent[]>();
    for (const e of events) {
      const k = eventDateYmd(e);
      if (!k) continue;
      const arr = map.get(k) ?? [];
      arr.push(e);
      map.set(k, arr);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => eventStartMs(a) - eventStartMs(b));
    }
    return map;
  }, [events]);

  const navMonth = (delta: number) => {
    let y = viewYear;
    let m = viewMonth + delta;
    while (m < 1) {
      y--;
      m += 12;
    }
    while (m > 12) {
      y++;
      m -= 12;
    }
    setViewYear(y);
    setViewMonth(m);
  };

  const openNewEvent = (forDate?: string) => {
    const day = forDate ?? selectedDate;
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, "0");
    const mm = "00";
    const nextHour = String((now.getHours() + 1) % 24).padStart(2, "0");
    setEditing({
      summary: "",
      description: "",
      location: "",
      allDay: false,
      startDate: day,
      startTime: `${hh}:${mm}`,
      endDate: day,
      endTime: `${nextHour}:${mm}`,
    });
  };

  const openEditEvent = (e: CalEvent) => {
    const allDay = !!e.start.date;
    const startIso = e.start.dateTime ?? `${e.start.date ?? selectedDate}T09:00:00+09:00`;
    const endIso = e.end.dateTime ?? `${e.end.date ?? selectedDate}T10:00:00+09:00`;
    const sd = new Date(startIso);
    const ed = new Date(endIso);
    setEditing({
      id: e.id,
      calendarId: e.calendarId,
      summary: e.summary ?? "",
      description: e.description ?? "",
      location: e.location ?? "",
      allDay,
      startDate: ymdJST(sd),
      startTime: allDay ? "09:00" : fmtTime(startIso),
      endDate: ymdJST(ed),
      endTime: allDay ? "10:00" : fmtTime(endIso),
    });
  };

  const saveEvent = async () => {
    if (!editing) return;
    const startIso = editing.allDay
      ? `${editing.startDate}T00:00:00+09:00`
      : `${editing.startDate}T${editing.startTime}:00+09:00`;
    const endIso = editing.allDay
      ? `${editing.endDate}T00:00:00+09:00`
      : `${editing.endDate}T${editing.endTime}:00+09:00`;
    const body = {
      summary: editing.summary.trim() || "(無題)",
      description: editing.description || undefined,
      location: editing.location || undefined,
      start: startIso,
      end: endIso,
      all_day: editing.allDay,
    };
    try {
      if (editing.id) {
        await fetch(
          `/api/calendar/events/${encodeURIComponent(editing.id)}?calendar=${encodeURIComponent(editing.calendarId ?? "primary")}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }
        );
      } else {
        const res = await fetch("/api/calendar/events", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        // intent dispatch から作られた場合は artifact_links に back-link
        if (intentSource && res.ok) {
          try {
            const created = (await res.clone().json()) as { event?: { id?: string } };
            const newId = created.event?.id;
            if (newId) {
              await fetch("/api/artifact-links", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  sourceType: intentSource.type,
                  sourceId: intentSource.id,
                  targetType: "event",
                  targetId: newId,
                  createdBy: "intent",
                }),
              });
            }
          } catch (e) {
            console.warn("[calendar] artifact_link attach failed:", e);
          }
        }
      }
      setEditing(null);
      await reload();
    } catch (e) {
      console.warn("[calendar] save failed:", e);
    }
  };

  const executeDelete = async () => {
    if (!deleting) return;
    try {
      await fetch(
        `/api/calendar/events/${encodeURIComponent(deleting.id)}?calendar=${encodeURIComponent(deleting.calendarId ?? "primary")}`,
        { method: "DELETE" }
      );
      setDeleting(null);
      setEditing(null);
      await reload();
    } catch (e) {
      console.warn("[calendar] delete failed:", e);
    }
  };

  const { mounted, closing } = useModalTransition(open);
  if (!mounted) return null;

  return (
    <div
      className={`calendar-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`calendar-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-modal-title"
      >
        <button
          type="button"
          className="calendar-modal-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <header className="calendar-modal-header">
          <h1 id="calendar-modal-title">カレンダー</h1>
          <div className="calendar-nav">
            <button type="button" className="calendar-nav-btn" onClick={() => navMonth(-1)} aria-label="前月">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="15 18 9 12 15 6" />
              </svg>
            </button>
            <span className="calendar-nav-month">{viewYear}年{viewMonth}月</span>
            <button type="button" className="calendar-nav-btn" onClick={() => navMonth(1)} aria-label="翌月">
              <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 18 15 12 9 6" />
              </svg>
            </button>
            <button
              type="button"
              className="calendar-today-btn"
              onClick={() => {
                // 日付跨ぎでも常に最新の今日を取りに行く
                const t = ymdJST(new Date());
                setToday(t);
                setViewYear(Number(t.slice(0, 4)));
                setViewMonth(Number(t.slice(5, 7)));
                setSelectedDate(t);
              }}
            >
              今日
            </button>
          </div>
          <button type="button" className="todo-add-btn" onClick={() => openNewEvent()}>
            ＋ 新規
          </button>
        </header>

        <div className="calendar-body">
          <div className="calendar-weekdays">
            {WEEKDAY_LABELS.map((w, i) => (
              <div key={w} className={`calendar-weekday ${i === 0 ? "sun" : i === 6 ? "sat" : ""}`}>
                {w}
              </div>
            ))}
          </div>
          <div className="calendar-grid">
            {grid.map((cell, i) => {
              const list = eventsByDay.get(cell.ymd) ?? [];
              const isToday = cell.ymd === today;
              const dow = i % 7;
              const MAX_VISIBLE = 4;
              return (
                <div
                  key={`${cell.ymd}-${i}`}
                  className={`calendar-cell ${cell.inMonth ? "" : "out"} ${isToday ? "today" : ""} ${dow === 0 ? "sun" : dow === 6 ? "sat" : ""}`}
                  onDoubleClick={() => openNewEvent(cell.ymd)}
                >
                  <span className="calendar-cell-day">
                    {Number(cell.ymd.slice(8, 10))}
                    {weatherByDate.get(cell.ymd) && (
                      <span className="calendar-cell-weather-wrap">
                        <WeatherIcon
                          code={weatherByDate.get(cell.ymd)!.conditionCode}
                          size={14}
                          className="calendar-cell-weather"
                        />
                        <span className="calendar-cell-temps">
                          <span className="hi">{Math.round(weatherByDate.get(cell.ymd)!.tempMax)}°</span>
                          <span className="lo">{Math.round(weatherByDate.get(cell.ymd)!.tempMin)}°</span>
                        </span>
                        {weatherByDate.get(cell.ymd)!.precipChance !== null &&
                          weatherByDate.get(cell.ymd)!.precipChance! > 0.1 && (
                            <span className="calendar-cell-precip">
                              {Math.round(weatherByDate.get(cell.ymd)!.precipChance! * 100)}%
                            </span>
                          )}
                      </span>
                    )}
                  </span>
                  <div className="calendar-cell-events">
                    {list.slice(0, MAX_VISIBLE).map((e) => {
                      const pcolor = eventProjectColor.get(e.id);
                      return (
                        <button
                          type="button"
                          key={e.id}
                          className={`calendar-event-chip ${e.start.date ? "allday" : ""}`}
                          onClick={(ev) => {
                            ev.stopPropagation();
                            setDetail({ event: e, x: ev.clientX, y: ev.clientY });
                          }}
                          title={e.summary ?? "(無題)"}
                          style={pcolor ? { color: pcolor } : undefined}
                        >
                          {e.start.dateTime && (
                            <span className="calendar-event-chip-time">{fmtTime(e.start.dateTime)}</span>
                          )}
                          <span className="calendar-event-chip-summary">{e.summary ?? "(無題)"}</span>
                        </button>
                      );
                    })}
                    {list.length > MAX_VISIBLE && (
                      <button
                        type="button"
                        className="calendar-event-more"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          setDayList({ ymd: cell.ymd, events: list, x: ev.clientX, y: ev.clientY });
                        }}
                      >
                        他 {list.length - MAX_VISIBLE} 件
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {dayList && (
          <DayListPopup
            ymd={dayList.ymd}
            events={dayList.events}
            anchorX={dayList.x}
            anchorY={dayList.y}
            onClose={() => setDayList(null)}
            onPick={(e, ev) => {
              setDayList(null);
              setDetail({ event: e, x: ev.clientX, y: ev.clientY });
            }}
            eventProjectColor={eventProjectColor}
          />
        )}

        {detail && (
          <EventDetailPopup
            event={detail.event}
            anchorX={detail.x}
            anchorY={detail.y}
            onClose={() => setDetail(null)}
            onEdit={() => {
              const e = detail.event;
              setDetail(null);
              openEditEvent(e);
            }}
            onDelete={() => {
              setDeleting(detail.event);
              setDetail(null);
            }}
          />
        )}

        {editing && (
          <EditPopup
            draft={editing}
            onChange={setEditing}
            onSave={() => void saveEvent()}
            onCancel={() => setEditing(null)}
            onAskDelete={() => {
              if (editing.id) {
                setDeleting(
                  events.find((x) => x.id === editing.id) ?? null
                );
              }
            }}
            onAskAddReminder={
              sessionId && editing.id ? () => setAddReminderForEvent(editing) : undefined
            }
          />
        )}

        {addReminderForEvent && sessionId && (
          <div
            className="reminder-popup-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setAddReminderForEvent(null);
            }}
          >
            <div className="reminder-popup" onClick={(e) => e.stopPropagation()}>
              <header className="reminder-popup-header">
                <h2>{addReminderForEvent.summary || "予定"} のリマインダー</h2>
              </header>
              <MiniReminderForm
                sessionId={sessionId}
                initial={{
                  kind: "event_due",
                  title: addReminderForEvent.summary || "予定",
                  scheduleKind: "once",
                  baseAt: addReminderForEvent.allDay
                    ? `${addReminderForEvent.startDate}T09:00:00+09:00`
                    : `${addReminderForEvent.startDate}T${addReminderForEvent.startTime}:00+09:00`,
                  leadMinutes: 30,
                }}
                lockKind="event_due"
                lockScheduleKind="once"
                onCancel={() => setAddReminderForEvent(null)}
                onSaved={() => setAddReminderForEvent(null)}
              />
            </div>
          </div>
        )}

        {deleting && (
          <div
            className="confirm-popup-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setDeleting(null);
            }}
          >
            <div className="confirm-popup" role="dialog" aria-modal="true">
              <h2 className="confirm-popup-title">イベント削除の確認</h2>
              <p className="confirm-popup-body">
                <strong className="confirm-popup-target">「{deleting.summary ?? "(無題)"}」</strong>
                を Google カレンダーから削除しますか?
                <br />
                <span className="confirm-popup-note">この操作は取り消せません。</span>
              </p>
              <div className="confirm-popup-actions">
                <button type="button" className="confirm-cancel-btn" onClick={() => setDeleting(null)}>
                  キャンセル
                </button>
                <button
                  type="button"
                  className="confirm-confirm-btn"
                  onClick={() => void executeDelete()}
                  autoFocus
                >
                  削除する
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function DayListPopup({
  ymd,
  events,
  anchorX,
  anchorY,
  onClose,
  onPick,
  eventProjectColor,
}: {
  ymd: string;
  events: CalEvent[];
  anchorX: number;
  anchorY: number;
  onClose: () => void;
  onPick: (e: CalEvent, ev: React.MouseEvent) => void;
  eventProjectColor: Map<string, string>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchorX + 8, top: anchorY + 8 });

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 12;
    let left = anchorX + 8;
    let top = anchorY + 8;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, anchorX - rect.width - 8);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, anchorY - rect.height - 8);
    }
    setPos({ left, top });
  }, [anchorX, anchorY]);

  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [onClose]);

  const d = new Date(`${ymd}T00:00:00+09:00`);
  const weekday = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  }).format(d);
  const dayNum = Number(ymd.slice(8, 10));

  return (
    <div
      ref={ref}
      className="calendar-daylist-popup"
      role="dialog"
      aria-modal="false"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="calendar-daylist-head">
        <div className="calendar-daylist-date">
          <span className="calendar-daylist-weekday">{weekday}</span>
          <span className="calendar-daylist-day">{dayNum}</span>
        </div>
        <button
          type="button"
          className="calendar-event-popup-icon"
          onClick={onClose}
          title="閉じる"
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>
      <ul className="calendar-daylist-items">
        {events.map((e) => {
          const pcolor = eventProjectColor.get(e.id);
          return (
            <li key={e.id}>
              <button
                type="button"
                className={`calendar-event-chip ${e.start.date ? "allday" : ""}`}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onPick(e, ev);
                }}
                title={e.summary ?? "(無題)"}
                style={pcolor ? { color: pcolor } : undefined}
              >
                {e.start.dateTime && (
                  <span className="calendar-event-chip-time">{fmtTime(e.start.dateTime)}</span>
                )}
                <span className="calendar-event-chip-summary">{e.summary ?? "(無題)"}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function EventDetailPopup({
  event,
  anchorX,
  anchorY,
  onClose,
  onEdit,
  onDelete,
}: {
  event: CalEvent;
  anchorX: number;
  anchorY: number;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchorX + 8, top: anchorY + 8 });

  useEffect(() => {
    // 画面端に寄った時に popup が見切れないよう anchor 位置を補正
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 12;
    let left = anchorX + 8;
    let top = anchorY + 8;
    if (left + rect.width > window.innerWidth - margin) {
      left = Math.max(margin, anchorX - rect.width - 8);
    }
    if (top + rect.height > window.innerHeight - margin) {
      top = Math.max(margin, anchorY - rect.height - 8);
    }
    setPos({ left, top });
  }, [anchorX, anchorY]);

  // 外側クリックで閉じる
  useEffect(() => {
    const onDocMouseDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDocMouseDown);
    return () => document.removeEventListener("mousedown", onDocMouseDown);
  }, [onClose]);

  const date = event.start.date ?? (event.start.dateTime ? event.start.dateTime.slice(0, 10) : "");
  const timeRange = event.start.dateTime
    ? `${fmtTime(event.start.dateTime)} 〜 ${fmtTime(event.end.dateTime)}`
    : "終日";
  const dateYmd = date ? new Date(`${date}T00:00:00+09:00`) : null;
  const dateLabel = dateYmd
    ? new Intl.DateTimeFormat("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "long",
        day: "numeric",
        weekday: "short",
      }).format(dateYmd)
    : "";

  return (
    <div
      ref={ref}
      className="calendar-event-popup"
      role="dialog"
      aria-modal="false"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="calendar-event-popup-head">
        <button type="button" className="calendar-event-popup-icon" onClick={onEdit} title="編集" aria-label="編集">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 3.3a2.4 2.4 0 0 1 3.4 3.4L7 18l-4 1 1-4 10.7-11.7z" />
          </svg>
        </button>
        <button type="button" className="calendar-event-popup-icon" onClick={onDelete} title="削除" aria-label="削除">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8L5 6" />
            <path d="M10 11v6M14 11v6" />
          </svg>
        </button>
        <button type="button" className="calendar-event-popup-icon" onClick={onClose} title="閉じる" aria-label="閉じる">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>
      </div>
      <h3 className="calendar-event-popup-title">{event.summary ?? "(無題)"}</h3>
      <div className="calendar-event-popup-meta">
        {dateLabel}
        {event.start.dateTime && (
          <>
            <span className="calendar-event-popup-sep">・</span>
            {timeRange}
          </>
        )}
        {event.start.date && (
          <>
            <span className="calendar-event-popup-sep">・</span>
            終日
          </>
        )}
      </div>
      {event.location && <div className="calendar-event-popup-loc">{event.location}</div>}
      {event.description && (
        <div className="calendar-event-popup-desc">{event.description}</div>
      )}
      {event.calendarSummary && (
        <div className="calendar-event-popup-cal">{event.calendarSummary}</div>
      )}
    </div>
  );
}

function EditPopup({
  draft,
  onChange,
  onSave,
  onCancel,
  onAskDelete,
  onAskAddReminder,
}: {
  draft: DraftEvent;
  onChange: (d: DraftEvent) => void;
  onSave: () => void;
  onCancel: () => void;
  onAskDelete: () => void;
  onAskAddReminder?: () => void;
}) {
  const firstInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    firstInputRef.current?.focus();
  }, []);

  const set = (patch: Partial<DraftEvent>) => onChange({ ...draft, ...patch });

  return (
    <div
      className="confirm-popup-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div className="confirm-popup confirm-popup-accent calendar-edit-popup" role="dialog" aria-modal="true">
        <div className="calendar-edit-popup-head">
          <h2 className="confirm-popup-title">
            {draft.id ? "予定を編集" : "予定を追加"}
          </h2>
          {draft.id && (
            <IntentKebabMenu
              sourceRefId={draft.id}
              sourcePayload={{
                type: "event",
                data: {
                  summary: draft.summary,
                  description: draft.description || undefined,
                  startIso: draft.allDay
                    ? `${draft.startDate}T00:00:00+09:00`
                    : `${draft.startDate}T${draft.startTime}:00+09:00`,
                  endIso: draft.allDay
                    ? `${draft.endDate}T00:00:00+09:00`
                    : `${draft.endDate}T${draft.endTime}:00+09:00`,
                  location: draft.location || undefined,
                },
              }}
              targets={["todo"]}
            />
          )}
        </div>
        <div className="calendar-edit-fields">
          <label className="project-edit-label">
            <span>タイトル</span>
            <input
              name="calendar-title"
              ref={firstInputRef}
              type="text"
              value={draft.summary}
              onChange={(e) => set({ summary: e.target.value })}
              placeholder="予定のタイトル"
            />
          </label>

          <label className="project-edit-label calendar-edit-allday">
            <input
              type="checkbox"
              checked={draft.allDay}
              onChange={(e) => set({ allDay: e.target.checked })}
            />
            <span>終日</span>
          </label>

          <div className="calendar-edit-grid">
            <label className="project-edit-label">
              <span>開始</span>
              <input name="calendar-start-date" type="date" value={draft.startDate} onChange={(e) => set({ startDate: e.target.value })} />
            </label>
            {!draft.allDay && (
              <label className="project-edit-label">
                <span>開始時刻</span>
                <input name="calendar-start-time" type="time" value={draft.startTime} onChange={(e) => set({ startTime: e.target.value })} />
              </label>
            )}
            <label className="project-edit-label">
              <span>終了</span>
              <input name="calendar-end-date" type="date" value={draft.endDate} onChange={(e) => set({ endDate: e.target.value })} />
            </label>
            {!draft.allDay && (
              <label className="project-edit-label">
                <span>終了時刻</span>
                <input name="calendar-end-time" type="time" value={draft.endTime} onChange={(e) => set({ endTime: e.target.value })} />
              </label>
            )}
          </div>

          <label className="project-edit-label">
            <span>場所</span>
            <input
              name="calendar-location"
              type="text"
              value={draft.location}
              onChange={(e) => set({ location: e.target.value })}
              placeholder="(任意)"
            />
          </label>

          <label className="project-edit-label">
            <span>メモ</span>
            <textarea
              name="calendar-description"
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
              placeholder="(任意)"
              rows={3}
            />
          </label>

          {/* 既存イベント編集時のみ project chip 表示 (新規作成時は ID が無いので不可) */}
          {draft.id && (
            <div className="project-edit-label">
              <span>プロジェクト</span>
              <ProjectChipsEditor
                artifactType="event"
                artifactId={draft.id}
                artifactPayload={{
                  type: "event",
                  data: {
                    summary: draft.summary,
                    description: draft.description || undefined,
                    startIso: draft.allDay
                      ? `${draft.startDate}T00:00:00+09:00`
                      : `${draft.startDate}T${draft.startTime}:00+09:00`,
                    endIso: draft.allDay
                      ? `${draft.endDate}T00:00:00+09:00`
                      : `${draft.endDate}T${draft.endTime}:00+09:00`,
                    location: draft.location || undefined,
                  },
                }}
              />
            </div>
          )}
          {draft.id && (
            <ArtifactLinksPanel artifactType="event" artifactId={draft.id} />
          )}
        </div>
        <div className="confirm-popup-actions calendar-edit-actions">
          {draft.id && (
            <button type="button" className="confirm-cancel-btn calendar-edit-delete" onClick={onAskDelete}>
              削除
            </button>
          )}
          {draft.id && onAskAddReminder && (
            <button
              type="button"
              className="todo-add-reminder-btn"
              onClick={onAskAddReminder}
              title="この予定のリマインダーを追加"
            >
              + リマインダー
            </button>
          )}
          <button type="button" className="confirm-cancel-btn" onClick={onCancel}>
            キャンセル
          </button>
          <button type="button" className="todo-add-btn" onClick={onSave} disabled={!draft.summary.trim()}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
