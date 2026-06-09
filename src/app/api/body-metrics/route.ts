/**
 * GET  /api/body-metrics?type=weight_kg&limit=30
 *   指定 metric_type の直近 N 件を返す (新→古)。
 *
 * POST /api/body-metrics
 *   body: { metric_type, value, recorded_at?, notes?, source? }
 *   metric を 1 件追加。recorded_at 省略時は現在時刻。
 *
 * 設計: docs/food-tracking.md §4.3
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { bodyMetrics } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

/** 各 metric_type の有効範囲 (誤入力の暴走防止)。 */
const METRIC_RANGES: Record<string, { min: number; max: number }> = {
  weight_kg:     { min: 30, max: 150 },
  body_fat_pct:  { min: 3,  max: 60 },
  mood_1to5:     { min: 1,  max: 5 },
};

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type");
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "30", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 365)) : 30;
  if (!type) {
    return NextResponse.json({ error: "type param required" }, { status: 400 });
  }
  const rows = await db
    .select()
    .from(bodyMetrics)
    .where(eq(bodyMetrics.metricType, type))
    .orderBy(desc(bodyMetrics.recordedAt))
    .limit(limit);
  return NextResponse.json({
    count: rows.length,
    metrics: rows.map((r) => ({
      id: Number(r.id),
      metricType: r.metricType,
      value: r.value,
      recordedAt: r.recordedAt.toISOString(),
      notes: r.notes,
      source: r.source,
    })),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      metric_type?: string;
      value?: number;
      recorded_at?: string;
      notes?: string;
      source?: string;
    };
    if (typeof body.metric_type !== "string" || body.metric_type.length === 0) {
      return NextResponse.json({ error: "metric_type required" }, { status: 400 });
    }
    if (typeof body.value !== "number" || !Number.isFinite(body.value)) {
      return NextResponse.json({ error: "value (number) required" }, { status: 400 });
    }
    const range = METRIC_RANGES[body.metric_type];
    if (range && (body.value < range.min || body.value > range.max)) {
      return NextResponse.json(
        { error: `value out of range for ${body.metric_type} (${range.min}〜${range.max})` },
        { status: 400 }
      );
    }
    const recordedAt = body.recorded_at ? new Date(body.recorded_at) : new Date();
    if (Number.isNaN(recordedAt.getTime())) {
      return NextResponse.json({ error: "invalid recorded_at" }, { status: 400 });
    }
    const [row] = await db
      .insert(bodyMetrics)
      .values({
        metricType: body.metric_type,
        value: body.value,
        recordedAt,
        notes: body.notes,
        source: body.source ?? "manual",
      })
      .returning({ id: bodyMetrics.id });
    return NextResponse.json({ id: Number(row.id), ok: true });
  } catch (e) {
    return clientError(req, e, { context: "body-metrics", message: "体組成データの記録に失敗しました" });
  }
}
