import { listEvents } from "@/lib/gcal";
import { isCalendarReadonly } from "../availability/google";
import { summarizeEvent } from "./_helpers";
import type { ToolDef } from "../types";

export const gcalListEvents: ToolDef = {
  name: "gcal_list_events",
  description:
    "指定期間のイベント一覧を取得します。" +
    "calendar_id 省略時は **GCal UI で表示中の全カレンダーを横断** (primary + 共有カレンダー含む)。" +
    "特定カレンダーだけ見たい時のみ calendar_id を渡す。" +
    "timeMin/timeMax は RFC3339 (例: '2026-05-24T00:00:00+09:00')。" +
    "q でキーワード検索も可能 (タイトル/本文/参加者 partial match)。",
  input_schema: {
    type: "object",
    properties: {
      calendar_id: {
        type: "string",
        description: "省略時は表示中の全カレンダー横断。特定指定したい時のみ id を渡す",
      },
      time_min: { type: "string", description: "RFC3339 start (inclusive)" },
      time_max: { type: "string", description: "RFC3339 end (exclusive)" },
      q: { type: "string", description: "キーワード検索 (optional)" },
      max_results: { type: "integer", default: 20 },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "specialist", id: "schedule" }],
  surface: "read",
  domain: "schedule",
  // event 本文 / description は招待元が書ける → 第三者注入可能
  untrustedOutput: true,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  availabilityKey: "google:calendar.readonly",
  isAvailable: isCalendarReadonly,
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const items = await listEvents({
      calendarId: typeof i.calendar_id === "string" ? i.calendar_id : undefined,
      timeMin: typeof i.time_min === "string" ? i.time_min : undefined,
      timeMax: typeof i.time_max === "string" ? i.time_max : undefined,
      q: typeof i.q === "string" ? i.q : undefined,
      maxResults: typeof i.max_results === "number" ? i.max_results : undefined,
    });
    return {
      count: items.length,
      events: items.map(summarizeEvent),
    };
  },
};
