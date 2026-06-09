import { updateEvent, type CalEventTime } from "@/lib/gcal";
import { isCalendarEvents } from "../availability/google";
import { summarizeEvent } from "./_helpers";
import type { ToolDef } from "../types";

export const gcalUpdateEvent: ToolDef = {
  name: "gcal_update_event",
  description: "既存イベントを部分更新します。指定したフィールドだけ書き換え。",
  input_schema: {
    type: "object",
    properties: {
      calendar_id: { type: "string" },
      event_id: { type: "string" },
      summary: { type: "string" },
      description: { type: "string" },
      location: { type: "string" },
      start: { type: "object" },
      end: { type: "object" },
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
    const event = await updateEvent({
      calendarId: typeof i.calendar_id === "string" ? i.calendar_id : undefined,
      eventId: String(i.event_id),
      summary: typeof i.summary === "string" ? i.summary : undefined,
      description: typeof i.description === "string" ? i.description : undefined,
      location: typeof i.location === "string" ? i.location : undefined,
      start: i.start ? (i.start as CalEventTime) : undefined,
      end: i.end ? (i.end as CalEventTime) : undefined,
    });
    return {
      updated: true,
      event: summarizeEvent(event),
    };
  },
};
