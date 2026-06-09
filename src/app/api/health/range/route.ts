/**
 * GET /api/health/range?mode=day|week|month&date=YYYY-MM-DD
 *
 * 指定範囲のヘルスデータを一括返却。HealthModal の日次/週次/月次 view が使う。
 *
 * mode=day:
 *   date 当日 (00:00–24:00 JST) の food / workout / activity(daily metrics) / weight・mood entries
 *
 * mode=week:
 *   date を含む 7 日 (date を最終日とする 6 日前〜当日) の日別集計
 *
 * mode=month:
 *   date を含む月 (1 日〜末日 JST) の日別集計
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { bodyMetrics, foodLogs, workoutLogs } from "@/db/schema";
import { and, asc, desc, gte, inArray, lt } from "drizzle-orm";

export const dynamic = "force-dynamic";

const DAILY_METRICS = [
  "steps_daily",
  "active_kcal_daily",
  "basal_kcal_daily",
  "exercise_min_daily",
  "stand_hours_daily",
  "distance_km_daily",
  "sleep_hours_daily",
];
const POINT_METRICS = ["heart_rate", "resting_hr", "spo2"];
const SCALAR_METRICS = ["weight_kg", "body_fat_pct", "mood_1to5"];

function jstYmdOf(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function jstDayBoundsOf(ymd: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const start = new Date(`${ymd}T00:00:00+09:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function shiftDays(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return jstYmdOf(d);
}

function monthBoundsOf(ymd: string): { startYmd: string; endYmd: string } | null {
  const m = ymd.match(/^(\d{4})-(\d{2})-\d{2}$/);
  if (!m) return null;
  const y = parseInt(m[1], 10), mo = parseInt(m[2], 10);
  const startYmd = `${y}-${String(mo).padStart(2, "0")}-01`;
  // 月末 = 翌月 1 日の前日
  const nextMo = new Date(`${y}-${String(mo).padStart(2, "0")}-01T00:00:00+09:00`);
  nextMo.setUTCMonth(nextMo.getUTCMonth() + 1);
  nextMo.setUTCDate(0);
  const endYmd = jstYmdOf(nextMo);
  return { startYmd, endYmd };
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const mode = (url.searchParams.get("mode") ?? "day") as "day" | "week" | "month";
  const dateParam = url.searchParams.get("date") ?? jstYmdOf(new Date());
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
    return NextResponse.json({ error: "invalid date" }, { status: 400 });
  }

  let startYmd: string, endYmd: string;
  if (mode === "day") {
    startYmd = dateParam;
    endYmd = dateParam;
  } else if (mode === "week") {
    endYmd = dateParam;
    startYmd = shiftDays(endYmd, -6);
  } else if (mode === "month") {
    const mb = monthBoundsOf(dateParam);
    if (!mb) return NextResponse.json({ error: "invalid date" }, { status: 400 });
    startYmd = mb.startYmd;
    endYmd = mb.endYmd;
  } else {
    return NextResponse.json({ error: "invalid mode" }, { status: 400 });
  }

  const startBounds = jstDayBoundsOf(startYmd);
  const endBounds = jstDayBoundsOf(endYmd);
  if (!startBounds || !endBounds) {
    return NextResponse.json({ error: "invalid date" }, { status: 400 });
  }
  const rangeStart = startBounds.start;
  const rangeEnd = endBounds.end;

  // --- 食事 ---
  const foods = await db
    .select()
    .from(foodLogs)
    .where(and(gte(foodLogs.eatenAt, rangeStart), lt(foodLogs.eatenAt, rangeEnd)))
    .orderBy(asc(foodLogs.eatenAt));

  // --- 筋トレ ---
  const workouts = await db
    .select()
    .from(workoutLogs)
    .where(and(gte(workoutLogs.performedAt, rangeStart), lt(workoutLogs.performedAt, rangeEnd)))
    .orderBy(desc(workoutLogs.performedAt));

  // --- 日次メトリクス (activity) ---
  // ORDER BY recorded_at ASC で取得し、ループの最終代入 = その (type, ymd) の最新値、
  // となるようにする。ORDER BY 無しだと DB 返却順は未定義なので「last write wins」が
  // 「最新優先」に必ずしも一致しない (同日複数記録 = HealthKit re-import 等で実害が出る)。
  const dailyRows = await db
    .select()
    .from(bodyMetrics)
    .where(
      and(
        inArray(bodyMetrics.metricType, DAILY_METRICS),
        gte(bodyMetrics.recordedAt, rangeStart),
        lt(bodyMetrics.recordedAt, rangeEnd)
      )
    )
    .orderBy(asc(bodyMetrics.recordedAt));
  // type → ymd → value (= 同日複数件は ORDER BY ASC により最後に書き込まれる最新値が残る)
  const dailyByType: Record<string, Record<string, number>> = {};
  for (const t of DAILY_METRICS) dailyByType[t] = {};
  for (const r of dailyRows) {
    const ymd = jstYmdOf(r.recordedAt);
    dailyByType[r.metricType][ymd] = r.value;
  }

  // --- scalar metrics (weight / body_fat / mood) ---
  const scalarRows = await db
    .select()
    .from(bodyMetrics)
    .where(
      and(
        inArray(bodyMetrics.metricType, SCALAR_METRICS),
        gte(bodyMetrics.recordedAt, rangeStart),
        lt(bodyMetrics.recordedAt, rangeEnd)
      )
    )
    .orderBy(asc(bodyMetrics.recordedAt));

  // --- point-in-time (HR / SpO2) ---
  const pointRows = await db
    .select()
    .from(bodyMetrics)
    .where(
      and(
        inArray(bodyMetrics.metricType, POINT_METRICS),
        gte(bodyMetrics.recordedAt, rangeStart),
        lt(bodyMetrics.recordedAt, rangeEnd)
      )
    )
    .orderBy(desc(bodyMetrics.recordedAt));

  // 全 ymd を列挙 (sparse でも完全列にする)
  const ymdList: string[] = [];
  let cur = startYmd;
  while (cur <= endYmd) {
    ymdList.push(cur);
    cur = shiftDays(cur, 1);
  }

  // --- 食事の日別集計 (week/month 用) ---
  const foodDaily: Record<string, { kcal: number; count: number; hasUnknown: boolean }> = {};
  for (const y of ymdList) foodDaily[y] = { kcal: 0, count: 0, hasUnknown: false };
  for (const f of foods) {
    const y = jstYmdOf(f.eatenAt);
    const cell = foodDaily[y];
    if (!cell) continue;
    cell.count++;
    if (f.totalKcal === null) cell.hasUnknown = true;
    else cell.kcal += f.totalKcal;
  }

  // --- 筋トレの日別集計 ---
  const workoutDaily: Record<string, { count: number; bodyParts: string[] }> = {};
  for (const y of ymdList) workoutDaily[y] = { count: 0, bodyParts: [] };
  for (const w of workouts) {
    const y = jstYmdOf(w.performedAt);
    const cell = workoutDaily[y];
    if (!cell) continue;
    cell.count++;
    if (Array.isArray(w.bodyParts)) {
      for (const p of w.bodyParts) {
        if (typeof p === "string" && !cell.bodyParts.includes(p)) cell.bodyParts.push(p);
      }
    }
  }

  // --- scalar (体重・気分) を ymd ごとに最初の値 (or 平均?) → 1 日 1 値 (最後) ---
  const scalarDaily: Record<string, Record<string, number>> = {};
  for (const t of SCALAR_METRICS) scalarDaily[t] = {};
  for (const r of scalarRows) {
    const y = jstYmdOf(r.recordedAt);
    scalarDaily[r.metricType][y] = r.value; // asc 順なので最後の値が残る
  }

  return NextResponse.json({
    mode,
    date: dateParam,
    startYmd,
    endYmd,
    ymdList,
    foods: foods.map((r) => ({
      id: Number(r.id),
      eatenAt: r.eatenAt.toISOString(),
      items: r.items,
      totalKcal: r.totalKcal,
      totalProtein: r.totalProtein,
      totalCarbs: r.totalCarbs,
      totalFat: r.totalFat,
      totalFiber: r.totalFiber,
      confidence: r.confidence,
    })),
    workouts: workouts.map((r) => ({
      id: Number(r.id),
      performedAt: r.performedAt.toISOString(),
      bodyParts: r.bodyParts,
      exercises: r.exercises,
      durationMin: r.durationMin,
      intensity: r.intensity,
      notes: r.notes,
    })),
    activityDaily: dailyByType,    // type → ymd → value
    scalarDaily,                    // type → ymd → value (weight_kg/body_fat_pct/mood_1to5)
    scalarPoints: scalarRows.map((r) => ({
      id: Number(r.id),
      metricType: r.metricType,
      value: r.value,
      recordedAt: r.recordedAt.toISOString(),
    })),
    points: pointRows.map((r) => ({
      metricType: r.metricType,
      value: r.value,
      recordedAt: r.recordedAt.toISOString(),
    })),
    foodDaily,
    workoutDaily,
  });
}
