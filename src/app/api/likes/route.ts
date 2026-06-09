/**
 * POST /api/likes
 *
 * VRM ダブルクリックで発火する「いいね」を記録するエンドポイント。
 *
 * body: { sessionId: string, clickX?: number, clickY?: number, messageId?: number | null }
 *
 * messageId が省略された場合は session_id 内の最新 assistant 応答に自動紐付け。
 * 該当無し (Yui 発話がまだない状態でのいいね) なら null で記録。
 *
 * レスポンスの shouldReact は「Yui に嬉しがり発話させてよいか」を返す。
 * 直前のいいねから REACT_THROTTLE_MS 以内なら false (= 連打中は音だけ抑制し、
 * ハート粒子と DB 記録は継続する)。
 */
import { NextResponse, type NextRequest } from "next/server";
import { and, desc, eq, gte } from "drizzle-orm";
import { db } from "@/db/client";
import { likeEvents, rawMessages } from "@/db/schema";
import { addXp } from "@/lib/xp";

const REACT_THROTTLE_MS = 5_000;

export async function POST(req: NextRequest) {
  let body: {
    sessionId?: unknown;
    messageId?: unknown;
    clickX?: unknown;
    clickY?: unknown;
  };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  const sessionId =
    typeof body.sessionId === "string" && body.sessionId.length > 0
      ? body.sessionId
      : null;
  if (!sessionId) {
    return NextResponse.json({ error: "sessionId required" }, { status: 400 });
  }

  const clickX = typeof body.clickX === "number" ? body.clickX : null;
  const clickY = typeof body.clickY === "number" ? body.clickY : null;

  // messageId: クライアント明示 > 自動 lookup (最新 assistant 応答)
  let messageId: number | null = null;
  if (typeof body.messageId === "number" && Number.isFinite(body.messageId)) {
    messageId = body.messageId;
  } else if (body.messageId === undefined) {
    const latest = await db
      .select({ id: rawMessages.id })
      .from(rawMessages)
      .where(and(eq(rawMessages.sessionId, sessionId), eq(rawMessages.role, "assistant")))
      .orderBy(desc(rawMessages.id))
      .limit(1);
    messageId = latest[0]?.id ?? null;
  }

  // throttle 判定: 5 秒以内の前回いいねがあれば、発話は抑える
  const cutoff = new Date(Date.now() - REACT_THROTTLE_MS);
  const recent = await db
    .select({ id: likeEvents.id })
    .from(likeEvents)
    .where(and(eq(likeEvents.sessionId, sessionId), gte(likeEvents.createdAt, cutoff)))
    .limit(1);
  const shouldReact = recent.length === 0;

  const [inserted] = await db
    .insert(likeEvents)
    .values({
      sessionId,
      messageId: messageId ?? undefined,
      clickX: clickX ?? undefined,
      clickY: clickY ?? undefined,
    })
    .returning({ id: likeEvents.id });

  // ハート 1 個 = heart_received +5 XP。like_events.id で重複防止。
  if (inserted) {
    void addXp({
      eventType: "heart_received",
      refTable: "like_events",
      refId: inserted.id,
    });
  }

  return NextResponse.json({ ok: true, shouldReact, messageId });
}
