/**
 * GET /api/timers?session=<uuid>
 *   → 指定 session の active (pending) timer 全件を返す。
 *   frontend が mount 時に状態復元するために使う。
 *
 * Yui 経由で作るのが主なので POST は省略。
 */
import { NextResponse, type NextRequest } from "next/server";
import { listActiveTimers } from "@/lib/timers";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session");
  if (!sessionId) {
    return NextResponse.json({ error: "session required" }, { status: 400 });
  }
  try {
    const list = await listActiveTimers(sessionId);
    return NextResponse.json({
      count: list.length,
      timers: list.map((t) => ({
        id: t.id,
        kind: t.kind,
        label: t.label,
        target_at: t.targetAt.toISOString(),
        created_at: t.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "timers", message: "タイマー一覧の取得に失敗しました" });
  }
}
