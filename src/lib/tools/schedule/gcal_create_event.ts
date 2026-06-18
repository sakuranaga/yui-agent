import { createEvent, type CalEventTime } from "@/lib/gcal";
import { isCalendarEvents } from "../availability/google";
import { summarizeEvent } from "./_helpers";
import { normalizeAnchorDateTime } from "../dedup-guard";
import type { ToolDef } from "../types";

/**
 * イベント作成。attendees あり → 外部に通知が飛ぶので confirm_external_send。
 * attendees 無し (= 自分用イベント) でも user 確認したい設計判断: 一律 confirm_destructive 相当。
 * MVP は「attendees の有無で policy 切替」せず、常に confirm_external_send とする
 * (= 「予定追加していい?」のように常に user に確認、UX 統一)。
 */
export const gcalCreateEvent: ToolDef = {
  name: "gcal_create_event",
  description:
    "イベントを作成します。start/end は { dateTime: '2026-05-25T10:00:00+09:00', timeZone: 'Asia/Tokyo' } " +
    "形式、または終日なら { date: '2026-05-25' }。",
  input_schema: {
    type: "object",
    properties: {
      calendar_id: { type: "string", description: "省略時 'primary'" },
      summary: { type: "string", description: "イベントタイトル" },
      description: { type: "string" },
      location: { type: "string" },
      start: {
        type: "object",
        description: "{ dateTime, timeZone } または { date }",
      },
      end: {
        type: "object",
        description: "{ dateTime, timeZone } または { date }",
      },
      attendees: {
        type: "array",
        items: { type: "string" },
        description: "参加者メールアドレス配列",
      },
    },
    required: ["summary", "start", "end"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "specialist", id: "schedule" }],
  surface: "mutate",
  domain: "schedule",
  allowedModes: ["normal"],
  confirmationPolicy: "confirm_external_send",
  availabilityKey: "google:calendar.events",
  isAvailable: isCalendarEvents,
  // 重複ガード: 同カレンダー・同開始時刻で、タイトルが類似 (文字違いの同一予定) なら再登録しない。
  // 窓 24h: 会話履歴からの再実行は数時間後にも起きる (当日中の同一予定を弾く)。cleanup 保持も 24h で整合。
  dedup: {
    windowMinutes: 1440,
    scope: (input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      const cal = typeof i.calendar_id === "string" ? i.calendar_id : "primary";
      return `calendar:${cal}`;
    },
    anchor: (input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      const s = (i.start ?? {}) as Record<string, unknown>;
      const e = (i.end ?? {}) as Record<string, unknown>;
      const pick = (t: Record<string, unknown>) =>
        typeof t.dateTime === "string"
          ? t.dateTime
          : typeof t.date === "string"
            ? t.date
            : null;
      const startKey = normalizeAnchorDateTime(pick(s));
      if (!startKey) return null;
      // 終了分・終日フラグも含める (同開始・別終了/別終日の予定を別物として扱う、A6)。
      const endKey = normalizeAnchorDateTime(pick(e)) ?? "-";
      const allDay = typeof s.date === "string" ? "1" : "0";
      return `${startKey}|${endKey}|${allDay}`;
    },
    title: (input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      return typeof i.summary === "string" ? i.summary : "";
    },
  },
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const event = await createEvent({
      calendarId: typeof i.calendar_id === "string" ? i.calendar_id : undefined,
      summary: String(i.summary),
      description: typeof i.description === "string" ? i.description : undefined,
      location: typeof i.location === "string" ? i.location : undefined,
      start: i.start as CalEventTime,
      end: i.end as CalEventTime,
      attendees: Array.isArray(i.attendees) ? (i.attendees as string[]) : undefined,
    });
    return {
      created: true,
      event: summarizeEvent(event),
    };
  },
};
