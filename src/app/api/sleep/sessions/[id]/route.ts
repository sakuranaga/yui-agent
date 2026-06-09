/**
 * PATCH /api/sleep/sessions/[id]
 *   { stoppedBy: "manual"|"timer"|"unmount", wordsSpoken?, affirmationsSpoken? }
 *   stopped_at は server NOW() で確定する。
 *
 * 設計: docs/sleep-support.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepSessions } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const num = parseInt(id, 10);
  if (!Number.isFinite(num) || num <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const body = (await req.json().catch(() => null)) as
    | {
        stoppedBy?: string;
        wordsSpoken?: number;
        affirmationsSpoken?: number;
      }
    | null;

  const patch: {
    stoppedAt: Date;
    stoppedBy?: string;
    wordsSpoken?: number;
    affirmationsSpoken?: number;
  } = { stoppedAt: new Date() };
  if (typeof body?.stoppedBy === "string") patch.stoppedBy = body.stoppedBy;
  if (typeof body?.wordsSpoken === "number")
    patch.wordsSpoken = Math.max(0, Math.floor(body.wordsSpoken));
  if (typeof body?.affirmationsSpoken === "number")
    patch.affirmationsSpoken = Math.max(0, Math.floor(body.affirmationsSpoken));

  await db.update(sleepSessions).set(patch).where(eq(sleepSessions.id, num));
  return NextResponse.json({ ok: true });
}
