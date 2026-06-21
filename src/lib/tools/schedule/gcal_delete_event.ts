import { deleteEvent } from "@/lib/gcal";
import { isCalendarEvents } from "../availability/google";
import type { ToolDef } from "../types";

export const gcalDeleteEvent: ToolDef = {
  name: "gcal_delete_event",
  description: "イベントを削除します (元に戻せないので、明示依頼時のみ実行)。",
  input_schema: {
    type: "object",
    properties: {
      calendar_id: { type: "string" },
      event_id: { type: "string" },
      summary: {
        type: "string",
        description: "確認表示用のイベントタイトル。分かっている場合は必ず渡す",
      },
      start_jst: {
        type: "string",
        description: "確認表示用の開始時刻 (例: 2026-06-22 20:00 JST)。分かっている場合は必ず渡す",
      },
      end_jst: {
        type: "string",
        description: "確認表示用の終了時刻。分かっている場合のみ渡す",
      },
    },
    required: ["event_id"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "specialist", id: "schedule" }],
  surface: "mutate",
  domain: "schedule",
  allowedModes: ["normal"],
  confirmationPolicy: "confirm_destructive",
  availabilityKey: "google:calendar.events",
  isAvailable: isCalendarEvents,
  dedup: {
    windowMinutes: 1440,
    scope: (input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      const cal = typeof i.calendar_id === "string" ? i.calendar_id : "primary";
      return `calendar:${cal}`;
    },
    anchor: (input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      return typeof i.event_id === "string" ? i.event_id : null;
    },
    title: (input) => {
      const i = (input ?? {}) as Record<string, unknown>;
      return typeof i.event_id === "string" ? i.event_id : "delete_event";
    },
  },
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    await deleteEvent({
      calendarId: typeof i.calendar_id === "string" ? i.calendar_id : undefined,
      eventId: String(i.event_id),
    });
    return { deleted: true, event_id: String(i.event_id) };
  },
};
