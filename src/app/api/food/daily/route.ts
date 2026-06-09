/**
 * GET /api/food/daily?days=30
 *   過去 N 日 (JST) の日別 kcal 合計を返す (HealthModal 食事 sparkline 用)。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { foodLogs } from "@/db/schema";
import { and, asc, gte, lt } from "drizzle-orm";

export const dynamic = "force-dynamic";

function jstYmdOf(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return jstYmdOf(d);
}

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const daysRaw = parseInt(url.searchParams.get("days") ?? "30", 10);
  const days = Math.min(Math.max(Number.isFinite(daysRaw) ? daysRaw : 30, 1), 365);

  const today = jstYmdOf(new Date());
  const startYmd = shiftYmd(today, -(days - 1));
  const start = new Date(`${startYmd}T00:00:00+09:00`);
  const end = new Date(`${today}T00:00:00+09:00`);
  end.setUTCDate(end.getUTCDate() + 1);

  const rows = await db
    .select()
    .from(foodLogs)
    .where(and(gte(foodLogs.eatenAt, start), lt(foodLogs.eatenAt, end)))
    .orderBy(asc(foodLogs.eatenAt));

  const ymdList: string[] = [];
  let cur = startYmd;
  while (cur <= today) {
    ymdList.push(cur);
    cur = shiftYmd(cur, 1);
  }
  const daily: Record<string, { kcal: number; hasUnknown: boolean; count: number }> = {};
  for (const y of ymdList) daily[y] = { kcal: 0, hasUnknown: false, count: 0 };
  for (const r of rows) {
    const ymd = jstYmdOf(r.eatenAt);
    const cell = daily[ymd];
    if (!cell) continue;
    cell.count++;
    if (r.totalKcal === null) cell.hasUnknown = true;
    else cell.kcal += r.totalKcal;
  }

  return NextResponse.json({
    days,
    startYmd,
    endYmd: today,
    series: ymdList.map((y) => ({ ymd: y, ...daily[y] })),
  });
}
