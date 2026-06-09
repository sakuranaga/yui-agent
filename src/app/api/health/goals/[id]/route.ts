/**
 * PATCH  /api/health/goals/[id]   部分更新
 * DELETE /api/health/goals/[id]   削除
 */
import { NextResponse, type NextRequest } from "next/server";
import { updateGoal, deleteGoal, type GoalUpdate } from "@/lib/health-goals";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const g = await updateGoal(id, body as GoalUpdate);
    if (!g) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({
      goal: {
        id: Number(g.id),
        metricKey: g.metricKey,
        kind: g.kind,
        targetValue: g.targetValue,
        baselineValue: g.baselineValue,
        deadline: g.deadline ? g.deadline.toISOString().slice(0, 10) : null,
        startDate: g.startDate.toISOString().slice(0, 10),
        label: g.label,
        enabled: g.enabled,
        notes: g.notes,
        achievedAt: g.achievedAt ? g.achievedAt.toISOString() : null,
        createdAt: g.createdAt.toISOString(),
        updatedAt: g.updatedAt.toISOString(),
      },
    });
  } catch (e) {
    return clientError(req, e, { status: 400, context: "health/goals/[id]", message: "目標の更新に失敗しました" });
  }
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const ok = await deleteGoal(id);
  if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
