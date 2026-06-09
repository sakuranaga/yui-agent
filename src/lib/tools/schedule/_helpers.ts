import type { CalEvent } from "@/lib/gcal";

export function toJstString(t: { dateTime?: string; date?: string }): string {
  if (t.date) return t.date;
  if (!t.dateTime) return "";
  const d = new Date(t.dateTime);
  if (Number.isNaN(d.getTime())) return t.dateTime;
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} JST`;
}

export function summarizeEvent(e: CalEvent): Record<string, unknown> {
  return {
    id: e.id,
    status: e.status,
    summary: e.summary ?? "(no title)",
    description: e.description,
    location: e.location,
    start: e.start,
    end: e.end,
    start_jst: toJstString(e.start),
    end_jst: toJstString(e.end),
    attendees: e.attendees?.map((a) => ({ email: a.email, response: a.responseStatus })),
    organizer: e.organizer?.email,
    htmlLink: e.htmlLink,
    calendar_id: e.calendarId,
    calendar_summary: e.calendarSummary,
  };
}
