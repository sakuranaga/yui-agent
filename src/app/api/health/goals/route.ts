/**
 * GET  /api/health/goals?withStatus=1  全目標一覧 (任意で status 同梱)
 * POST /api/health/goals                新規作成
 *   body: { metric_key, kind, target_value, baseline_value?, deadline?, start_date?, label?, notes?, enabled? }
 */
import { NextResponse, type NextRequest } from "next/server";
import { listGoals, createGoal, evaluateGoal, type GoalInput } from "@/lib/health-goals";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const withStatus = req.nextUrl.searchParams.get("withStatus") === "1";
  const goals = await listGoals();
  if (!withStatus) {
    return NextResponse.json({ goals: goals.map(serialize) });
  }
  const now = new Date();
  const out = await Promise.all(
    goals.map(async (g) => ({
      goal: serialize(g),
      status: await evaluateGoal(g, now),
    }))
  );
  return NextResponse.json({ items: out });
}

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  try {
    const g = await createGoal(body as GoalInput);
    return NextResponse.json({ goal: serialize(g) }, { status: 201 });
  } catch (e) {
    return clientError(req, e, { status: 400, context: "health/goals", message: "目標の作成に失敗しました" });
  }
}

function serialize(g: Awaited<ReturnType<typeof listGoals>>[number]) {
  return {
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
  };
}
