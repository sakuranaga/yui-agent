/**
 * POST /api/notifications/seen_all?session=<id>
 *   全ての未読 notification を seen にする (一括既読)。
 */
import { NextResponse, type NextRequest } from "next/server";
import { markAllSeen } from "@/lib/notifications";
import { clientError } from "@/lib/api-error";

export async function POST(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session")?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "session required" }, { status: 400 });
  }
  try {
    const count = await markAllSeen(sessionId);
    return NextResponse.json({ ok: true, count });
  } catch (e) {
    return clientError(req, e, { context: "notifications/seen_all", message: "通知の一括既読化に失敗しました" });
  }
}
