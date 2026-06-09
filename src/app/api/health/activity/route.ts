/**
 * GET /api/health/activity
 *   HealthKit 取り込み済データの集約: 今日のサマリー + 7 日 sparkline + 直近 HR / SpO2 等を一括で返す。
 *   HealthModal の活動セクションが使う。
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { bodyMetrics } from "@/db/schema";
import { and, desc, eq, gte, inArray, lt } from "drizzle-orm";

export const dynamic = "force-dynamic";

const DAILY_TYPES = [
  "steps_daily",
  "active_kcal_daily",
  "basal_kcal_daily",
  "exercise_min_daily",
  "stand_hours_daily",
  "distance_km_daily",
  "sleep_hours_daily",
];
const POINT_TYPES = ["heart_rate", "resting_hr", "spo2"];

function jstYmdOf(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function jstDayBoundsOf(ymd: string): { start: Date; end: Date } {
  const start = new Date(`${ymd}T00:00:00+09:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

export async function GET() {
  const today = jstYmdOf(new Date());
  const todayBounds = jstDayBoundsOf(today);

  // 今日の日次代表値
  const todayRows = await db
    .select()
    .from(bodyMetrics)
    .where(
      and(
        inArray(bodyMetrics.metricType, DAILY_TYPES),
        gte(bodyMetrics.recordedAt, todayBounds.start),
        lt(bodyMetrics.recordedAt, todayBounds.end)
      )
    );
  const todayMap: Record<string, number> = {};
  for (const r of todayRows) {
    todayMap[r.metricType] = r.value;
  }

  // 7 日分の日次データを type ごとに [{ymd, value}] へ
  const sevenDaysAgo = new Date(todayBounds.end.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekRows = await db
    .select()
    .from(bodyMetrics)
    .where(
      and(
        inArray(bodyMetrics.metricType, DAILY_TYPES),
        gte(bodyMetrics.recordedAt, sevenDaysAgo),
        lt(bodyMetrics.recordedAt, todayBounds.end)
      )
    )
    .orderBy(desc(bodyMetrics.recordedAt));
  const sparklines: Record<string, Array<{ ymd: string; value: number }>> = {};
  for (const t of DAILY_TYPES) sparklines[t] = [];
  for (const r of weekRows) {
    sparklines[r.metricType]?.push({ ymd: jstYmdOf(r.recordedAt), value: r.value });
  }
  // 直近 1 件 / 日 (重複あれば最初を採用 = desc 取り) を残し、古→新でソート
  for (const t of DAILY_TYPES) {
    const seen = new Set<string>();
    const uniq: Array<{ ymd: string; value: number }> = [];
    for (const row of sparklines[t]) {
      if (seen.has(row.ymd)) continue;
      seen.add(row.ymd);
      uniq.push(row);
    }
    uniq.reverse();
    sparklines[t] = uniq;
  }

  // 直近 point-in-time
  const recentPoints: Record<string, Array<{ value: number; recordedAt: string }>> = {};
  for (const t of POINT_TYPES) {
    const rows = await db
      .select()
      .from(bodyMetrics)
      .where(eq(bodyMetrics.metricType, t))
      .orderBy(desc(bodyMetrics.recordedAt))
      .limit(10);
    recentPoints[t] = rows.map((r) => ({
      value: r.value,
      recordedAt: r.recordedAt.toISOString(),
    }));
  }

  // 最終取り込み時刻 (= 任意の HealthKit 系メトリクスで最も新しい created_at)
  const lastSyncRows = await db
    .select()
    .from(bodyMetrics)
    .where(inArray(bodyMetrics.metricType, [...DAILY_TYPES, ...POINT_TYPES]))
    .orderBy(desc(bodyMetrics.createdAt))
    .limit(1);
  const lastSync = lastSyncRows[0]?.createdAt.toISOString() ?? null;

  return NextResponse.json({
    date: today,
    today: todayMap,
    sparklines,
    recentPoints,
    lastSync,
  });
}
