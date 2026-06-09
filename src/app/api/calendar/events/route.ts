/**
 * GET /api/calendar/events?from=ISO&to=ISO
 *   期間内のイベント一覧 (全カレンダー横断、selected=true のもの含む)。
 * POST /api/calendar/events
 *   メイン (primary) カレンダーに新規イベント追加。
 *   body: { summary, start, end, all_day?, description?, location?, calendar_id? }
 */
import { NextResponse, type NextRequest } from "next/server";
import { listEvents, createEvent } from "@/lib/gcal";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get("from");
  const to = req.nextUrl.searchParams.get("to");
  if (!from || !to) {
    return NextResponse.json({ error: "from and to required (ISO)" }, { status: 400 });
  }
  try {
    // 月単位の表示なので 500 件まで許容 (default 20 はチャット tool 用に小さく
    // 設定されているため、CalendarModal では明示的に大きく取る)。
    const events = await listEvents({
      timeMin: from,
      timeMax: to,
      maxResults: 500,
    });
    return NextResponse.json({ count: events.length, events });
  } catch (e) {
    return clientError(req, e, { context: "calendar/events", message: "カレンダー予定の取得に失敗しました" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      summary?: string;
      start?: string;
      end?: string;
      all_day?: boolean;
      description?: string;
      location?: string;
      calendar_id?: string;
    };
    if (!body.summary || !body.start || !body.end) {
      return NextResponse.json({ error: "summary, start, end required" }, { status: 400 });
    }
    const event = await createEvent({
      calendarId: body.calendar_id ?? "primary",
      summary: body.summary,
      start: body.all_day
        ? { date: body.start.slice(0, 10) }
        : { dateTime: body.start },
      end: body.all_day
        ? { date: body.end.slice(0, 10) }
        : { dateTime: body.end },
      description: body.description,
      location: body.location,
    });
    return NextResponse.json({ ok: true, event });
  } catch (e) {
    return clientError(req, e, { context: "calendar/events", message: "カレンダー予定の作成に失敗しました" });
  }
}
