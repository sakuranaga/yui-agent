/**
 * GET /api/food/today
 *   JST 今日の食事ログ + 集計を返す。HealthModal の今日タブで使う。
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { foodLogs } from "@/db/schema";
import { and, gte, lt, asc } from "drizzle-orm";

export const dynamic = "force-dynamic";

function jstDayBounds(): { start: Date; end: Date; ymd: string } {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const ymd = `${g("year")}-${g("month")}-${g("day")}`;
  const start = new Date(`${ymd}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, ymd };
}

export async function GET() {
  const { start, end, ymd } = jstDayBounds();
  const rows = await db
    .select()
    .from(foodLogs)
    .where(and(gte(foodLogs.eatenAt, start), lt(foodLogs.eatenAt, end)))
    .orderBy(asc(foodLogs.eatenAt));

  let totalKcal = 0, totalP = 0, totalC = 0, totalF = 0, totalFiber = 0, totalSalt = 0;
  let allKnown = true;
  for (const r of rows) {
    if (r.totalKcal === null) { allKnown = false; continue; }
    totalKcal += r.totalKcal;
    totalP += r.totalProtein ?? 0;
    totalC += r.totalCarbs ?? 0;
    totalF += r.totalFat ?? 0;
    totalFiber += r.totalFiber ?? 0;
    totalSalt += r.totalSalt ?? 0;
  }

  return NextResponse.json({
    date: ymd,  // JST の YYYY-MM-DD (UTC slice ではない)
    count: rows.length,
    logs: rows.map((r) => ({
      id: Number(r.id),
      eatenAt: r.eatenAt.toISOString(),
      items: r.items,
      totalKcal: r.totalKcal,
      totalProtein: r.totalProtein,
      totalCarbs: r.totalCarbs,
      totalFat: r.totalFat,
      totalFiber: r.totalFiber,
      totalSalt: r.totalSalt,
      confidence: r.confidence,
    })),
    summary: {
      totalKcal: allKnown ? totalKcal : null,
      totalProtein: allKnown ? totalP : null,
      totalCarbs: allKnown ? totalC : null,
      totalFat: allKnown ? totalF : null,
      totalFiber: allKnown ? totalFiber : null,
      totalSalt: allKnown ? totalSalt : null,
      hasUnknown: !allKnown,
    },
  });
}
