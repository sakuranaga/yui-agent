/**
 * DELETE /api/workouts/[id] - 筋トレログを削除 (HealthModal の削除ボタン用)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { workoutLogs } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const deleted = await db.delete(workoutLogs).where(eq(workoutLogs.id, id)).returning();
  if (deleted.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
