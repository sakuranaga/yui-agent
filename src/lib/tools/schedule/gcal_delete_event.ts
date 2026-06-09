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
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    await deleteEvent({
      calendarId: typeof i.calendar_id === "string" ? i.calendar_id : undefined,
      eventId: String(i.event_id),
    });
    return { deleted: true, event_id: String(i.event_id) };
  },
};
