/**
 * POST /api/activity
 *   body: { sessionId, state: "online"|"away"|"focus", lastActivityAt: number }
 *   クライアントのユーザー状態をサーバ map に保存。
 *
 * GET /api/activity?session=<id>
 *   デバッグ用、現在の有効状態を返す。
 */
import { NextResponse, type NextRequest } from "next/server";
import { setActivity, getEffectiveState, type UserState } from "@/lib/activity";
import { db } from "@/db/client";
import { notifications } from "@/db/schema";
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { pushToSession } from "@/lib/jobs/events";
import { clientError } from "@/lib/api-error";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      sessionId?: string;
      state?: string;
      lastActivityAt?: number;
    };
    if (!body.sessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }
    if (
      body.state !== "online" &&
      body.state !== "away" &&
      body.state !== "focus" &&
      body.state !== "private"
    ) {
      return NextResponse.json({ error: "invalid state" }, { status: 400 });
    }
    const lastAt = typeof body.lastActivityAt === "number" ? body.lastActivityAt : Date.now();
    const transition = setActivity(body.sessionId, body.state as UserState, lastAt);

    // 集中モードから抜けた時、その間に積まれた未読 (seen 未設定) の通知件数を数えて
    // Yui の一言「集中中のお便りが ○件 ありました」を SSE で配信する。
    // 件数 0 のときは黙る (邪魔しない)。
    if (transition.exitedFocus && transition.focusEnteredAt) {
      try {
        const sinceDate = new Date(transition.focusEnteredAt);
        const [{ count }] = await db
          .select({ count: sql<number>`COUNT(*)::int` })
          .from(notifications)
          .where(
            and(
              eq(notifications.sessionId, body.sessionId),
              gte(notifications.createdAt, sinceDate),
              isNull(notifications.seenAt)
            )
          );
        if (count > 0) {
          pushToSession(body.sessionId, {
            type: "yui_message",
            jobId: Date.now(),
            text: `集中中のお便りが ${count} 件 ありました。お時間あればご覧くださいませ。`,
            emotion: "neutral",
          });
        }
      } catch (e) {
        console.warn("[activity] focus exit announcement failed:", e);
      }
    }

    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "activity", message: "ユーザー状態の更新に失敗しました" });
  }
}

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session")?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "session required" }, { status: 400 });
  }
  return NextResponse.json({ state: await getEffectiveState(sessionId) });
}
