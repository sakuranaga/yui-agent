import { getEvent } from "@/lib/gcal";
import { isCalendarReadonly } from "../availability/google";
import { summarizeEvent } from "./_helpers";
import type { ToolDef } from "../types";

export const gcalGetEvent: ToolDef = {
  name: "gcal_get_event",
  description: "個別イベントの詳細 (本文、参加者、場所等) を取得します。",
  input_schema: {
    type: "object",
    properties: {
      calendar_id: { type: "string", description: "省略時 'primary'" },
      event_id: { type: "string", description: "イベント ID" },
    },
    required: ["event_id"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "specialist", id: "schedule" }],
  surface: "read",
  domain: "schedule",
  untrustedOutput: true, // event description / attendees から注入
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  availabilityKey: "google:calendar.readonly",
  isAvailable: isCalendarReadonly,
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const event = await getEvent({
      calendarId: typeof i.calendar_id === "string" ? i.calendar_id : undefined,
      eventId: String(i.event_id),
    });
    return summarizeEvent(event);
  },
};
