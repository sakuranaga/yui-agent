/**
 * Google Calendar v3 REST client (薄いラッパ)。
 *
 * Yui の schedule_specialist の各 tool handler から呼ばれる。
 * OAuth user token は呼び出し時に getAccessTokenForMcp() で取得 (refresh も内包)。
 * X-Goog-User-Project ヘッダで billing project を明示。
 *
 * Google 公式 hosted MCP が personal Gmail から叩けなかったため、ここで MCP を介さず
 * 直接 REST 叩く構成 (Phase B continuation R 案)。
 */
import { getAccessTokenForMcp, googleCloudProject } from "./google-oauth";

const CAL_BASE = "https://www.googleapis.com/calendar/v3";
const OVERLAP_LOOKBACK_DAYS = 60;

function isConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

export function isGCalConfigured(): boolean {
  return isConfigured();
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessTokenForMcp();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const project = googleCloudProject();
  if (project) headers["X-Goog-User-Project"] = project;
  return headers;
}

async function callJson<T>(
  method: string,
  path: string,
  query?: Record<string, string | number | undefined>,
  body?: unknown
): Promise<T> {
  const url = new URL(`${CAL_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null && v !== "") {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const headers = await authHeaders();
  // eslint-disable-next-line no-restricted-syntax -- Google Calendar 公式 API (https://www.googleapis.com 固定)
  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Calendar API ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  // DELETE は通常 204 でボディなし
  if (res.status === 204) return {} as T;
  return (await res.json()) as T;
}

// --- Types (必要最小限) ---

export type CalendarListEntry = {
  id: string;
  summary: string;
  description?: string;
  primary?: boolean;
  /** Google Calendar UI で「表示中」かどうか。デフォルト true、明示的に hide すると false。 */
  selected?: boolean;
  accessRole: string;
  timeZone?: string;
  backgroundColor?: string;
};

export type CalEventTime = {
  dateTime?: string; // RFC3339 e.g. "2026-05-24T10:00:00+09:00"
  date?: string; // 終日 "YYYY-MM-DD"
  timeZone?: string;
};

export type CalEvent = {
  id: string;
  status?: "confirmed" | "tentative" | "cancelled";
  summary?: string;
  description?: string;
  location?: string;
  start: CalEventTime;
  end: CalEventTime;
  attendees?: Array<{ email: string; responseStatus?: string; displayName?: string }>;
  organizer?: { email: string; displayName?: string };
  htmlLink?: string;
  created?: string;
  updated?: string;
  /** どのカレンダー (primary / 共有 etc) から来たイベントか。複数カレンダー横断 listEvents で付与。 */
  calendarId?: string;
  calendarSummary?: string;
};

export type EventCreateInput = {
  calendarId?: string; // 省略時 "primary"
  summary: string;
  description?: string;
  location?: string;
  start: CalEventTime;
  end: CalEventTime;
  attendees?: string[]; // emails
};

export type EventUpdateInput = {
  calendarId?: string;
  eventId: string;
  summary?: string;
  description?: string;
  location?: string;
  start?: CalEventTime;
  end?: CalEventTime;
};

// --- API ---

export async function listCalendars(): Promise<CalendarListEntry[]> {
  type Resp = { items: CalendarListEntry[] };
  const data = await callJson<Resp>("GET", "/users/me/calendarList", { maxResults: 50 });
  return data.items ?? [];
}

export async function listEvents(opts: {
  /**
   * 取得対象。
   *  - 省略時: GCal UI で「表示中」(selected !== false) の全カレンダーを横断
   *  - "primary": ユーザの primary カレンダーのみ
   *  - 任意 id: 指定カレンダーのみ
   */
  calendarId?: string;
  timeMin?: string; // RFC3339
  timeMax?: string;
  q?: string;
  maxResults?: number;
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
}): Promise<CalEvent[]> {
  const singleEvents = opts.singleEvents ?? true; // 通常 true (繰返しを展開)
  // Google Calendar API の timeMin 境界だけに頼ると、開始日が検索期間より前の
  // 複数日予定を取りこぼすことがある。少し前から取得し、下で「期間に重なる」予定に絞る。
  const overlapWindow = buildOverlapWindow(opts.timeMin, opts.timeMax);

  // calendarId 未指定 → 表示中の全カレンダー横断
  if (!opts.calendarId) {
    const cals = await listCalendars();
    // selected !== false (= true もしくは未定義) のものを対象 = GCal UI で表示中のもの
    const visible = cals.filter((c) => c.selected !== false);
    if (visible.length === 0) return [];
    const perCalMax = Math.max(5, Math.ceil((opts.maxResults ?? 20) / visible.length));
    const fetchMax = overlapWindow ? Math.max(perCalMax, 250) : perCalMax;
    const results = await Promise.all(
      visible.map(async (c) => {
        try {
          const items = await fetchEventsFor(
            c.id,
            { ...opts, timeMin: overlapWindow?.fetchTimeMin ?? opts.timeMin, maxResults: fetchMax },
            singleEvents,
          );
          return items.map((e) => ({ ...e, calendarId: c.id, calendarSummary: c.summary }));
        } catch (err) {
          console.warn(`[gcal] listEvents on ${c.id} failed:`, err instanceof Error ? err.message : err);
          return [];
        }
      })
    );
    // 開始時刻で時系列 sort、上限まで切る
    const merged = overlapWindow
      ? results.flat().filter((e) => eventOverlaps(e, overlapWindow.minMs, overlapWindow.maxMs))
      : results.flat();
    merged.sort((a, b) => extractStartMs(a) - extractStartMs(b));
    const limit = opts.maxResults ?? 20;
    return merged.slice(0, limit);
  }

  const items = await fetchEventsFor(
    opts.calendarId,
    overlapWindow
      ? { ...opts, timeMin: overlapWindow.fetchTimeMin, maxResults: Math.max(opts.maxResults ?? 20, 250) }
      : opts,
    singleEvents,
  );
  return overlapWindow
    ? items
      .filter((e) => eventOverlaps(e, overlapWindow.minMs, overlapWindow.maxMs))
      .slice(0, opts.maxResults ?? 20)
    : items;
}

async function fetchEventsFor(
  calendarId: string,
  opts: {
    timeMin?: string;
    timeMax?: string;
    q?: string;
    maxResults?: number;
    orderBy?: "startTime" | "updated";
  },
  singleEvents: boolean
): Promise<CalEvent[]> {
  type Resp = { items: CalEvent[]; nextPageToken?: string };
  const data = await callJson<Resp>(
    "GET",
    `/calendars/${encodeURIComponent(calendarId)}/events`,
    {
      timeMin: opts.timeMin,
      timeMax: opts.timeMax,
      q: opts.q,
      maxResults: opts.maxResults ?? 20,
      singleEvents: singleEvents ? "true" : undefined,
      orderBy: opts.orderBy ?? (singleEvents ? "startTime" : undefined),
    }
  );
  return data.items ?? [];
}

function extractStartMs(e: CalEvent): number {
  const s = e.start.dateTime ?? e.start.date;
  if (!s) return 0;
  const t = new Date(s).getTime();
  return Number.isFinite(t) ? t : 0;
}

function buildOverlapWindow(timeMin?: string, timeMax?: string): {
  minMs: number;
  maxMs: number;
  fetchTimeMin: string;
} | null {
  if (!timeMin || !timeMax) return null;
  const minMs = Date.parse(timeMin);
  const maxMs = Date.parse(timeMax);
  if (!Number.isFinite(minMs) || !Number.isFinite(maxMs) || minMs >= maxMs) return null;
  return {
    minMs,
    maxMs,
    fetchTimeMin: new Date(minMs - OVERLAP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function calTimeMs(t: CalEventTime | undefined, fallback: number): number {
  if (!t) return fallback;
  if (t.dateTime) {
    const ms = Date.parse(t.dateTime);
    return Number.isFinite(ms) ? ms : fallback;
  }
  if (t.date) {
    const ms = Date.parse(`${t.date}T00:00:00+09:00`);
    return Number.isFinite(ms) ? ms : fallback;
  }
  return fallback;
}

function eventOverlaps(e: CalEvent, minMs: number, maxMs: number): boolean {
  const startMs = calTimeMs(e.start, minMs);
  const endMs = calTimeMs(e.end, startMs);
  return startMs < maxMs && endMs > minMs;
}

export async function getEvent(opts: {
  calendarId?: string;
  eventId: string;
}): Promise<CalEvent> {
  const cid = opts.calendarId ?? "primary";
  return await callJson<CalEvent>(
    "GET",
    `/calendars/${encodeURIComponent(cid)}/events/${encodeURIComponent(opts.eventId)}`
  );
}

export async function createEvent(input: EventCreateInput): Promise<CalEvent> {
  const cid = input.calendarId ?? "primary";
  const body: Record<string, unknown> = {
    summary: input.summary,
    start: input.start,
    end: input.end,
  };
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.attendees && input.attendees.length > 0) {
    body.attendees = input.attendees.map((email) => ({ email }));
  }
  return await callJson<CalEvent>(
    "POST",
    `/calendars/${encodeURIComponent(cid)}/events`,
    undefined,
    body
  );
}

export async function updateEvent(input: EventUpdateInput): Promise<CalEvent> {
  const cid = input.calendarId ?? "primary";
  // PATCH (部分更新) を使う
  const body: Record<string, unknown> = {};
  if (input.summary !== undefined) body.summary = input.summary;
  if (input.description !== undefined) body.description = input.description;
  if (input.location !== undefined) body.location = input.location;
  if (input.start !== undefined) body.start = input.start;
  if (input.end !== undefined) body.end = input.end;
  return await callJson<CalEvent>(
    "PATCH",
    `/calendars/${encodeURIComponent(cid)}/events/${encodeURIComponent(input.eventId)}`,
    undefined,
    body
  );
}

export async function deleteEvent(opts: {
  calendarId?: string;
  eventId: string;
}): Promise<void> {
  const cid = opts.calendarId ?? "primary";
  await callJson<unknown>(
    "DELETE",
    `/calendars/${encodeURIComponent(cid)}/events/${encodeURIComponent(opts.eventId)}`
  );
}
