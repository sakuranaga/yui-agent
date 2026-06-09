/**
 * PATCH /api/calendar/events/[id]?calendar=:cid
 *   イベント部分更新。calendar 省略時は primary。
 * DELETE /api/calendar/events/[id]?calendar=:cid
 *   イベント削除。
 */
import { NextResponse, type NextRequest } from "next/server";
import { updateEvent, deleteEvent } from "@/lib/gcal";
import { clientError } from "@/lib/api-error";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const calendarId = req.nextUrl.searchParams.get("calendar") ?? "primary";
  try {
    const body = (await req.json()) as {
      summary?: string;
      start?: string;
      end?: string;
      all_day?: boolean;
      description?: string;
      location?: string;
    };
    const event = await updateEvent({
      calendarId,
      eventId: id,
      summary: body.summary,
      description: body.description,
      location: body.location,
      start: body.start
        ? body.all_day
          ? { date: body.start.slice(0, 10) }
          : { dateTime: body.start }
        : undefined,
      end: body.end
        ? body.all_day
          ? { date: body.end.slice(0, 10) }
          : { dateTime: body.end }
        : undefined,
    });
    return NextResponse.json({ ok: true, event });
  } catch (e) {
    return clientError(req, e, { context: "calendar/events/[id]", message: "カレンダー予定の更新に失敗しました" });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const calendarId = req.nextUrl.searchParams.get("calendar") ?? "primary";
  try {
    await deleteEvent({ calendarId, eventId: id });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "calendar/events/[id]", message: "カレンダー予定の削除に失敗しました" });
  }
}
