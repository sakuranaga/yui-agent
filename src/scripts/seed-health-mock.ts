/**
 * HealthKit 取り込み UI 動作確認用のダミーデータ seed。
 *
 * 使い方:
 *   docker compose exec web npx tsx /app/src/scripts/seed-health-mock.ts
 *   docker compose exec web npx tsx /app/src/scripts/seed-health-mock.ts --clear
 *
 * --clear 付きで実行すると、apple_health_mock source の row を全部消す。
 * 動作確認後に必ず --clear で消すこと (実データを汚さない)。
 */
import { db } from "@/db/client";
import { bodyMetrics } from "@/db/schema";
import { eq } from "drizzle-orm";

const SOURCE = "apple_health_mock";

function jstDayEnd(daysAgo: number): Date {
  const base = new Date();
  base.setUTCDate(base.getUTCDate() - daysAgo);
  const ymd = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(base).reduce((acc, p) => {
    if (p.type === "year") acc.y = p.value;
    if (p.type === "month") acc.m = p.value;
    if (p.type === "day") acc.d = p.value;
    return acc;
  }, { y: "", m: "", d: "" });
  return new Date(`${ymd.y}-${ymd.m}-${ymd.d}T23:59:59+09:00`);
}

function rand(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

async function clear() {
  const deleted = await db
    .delete(bodyMetrics)
    .where(eq(bodyMetrics.source, SOURCE))
    .returning();
  console.log(`Deleted ${deleted.length} mock rows.`);
}

async function seed() {
  // 7 日分 (0=今日, 6=6日前)
  const inserts: Array<{
    metricType: string;
    value: number;
    recordedAt: Date;
    source: string;
    sourceMessageId: number | null;
  }> = [];

  for (let d = 0; d <= 6; d++) {
    const ts = jstDayEnd(d);
    // 歩数 8k–14k
    inserts.push({ metricType: "steps_daily", value: Math.round(rand(8000, 14000)), recordedAt: ts, source: SOURCE, sourceMessageId: null });
    // 距離 5–11km
    inserts.push({ metricType: "distance_km_daily", value: Number(rand(5, 11).toFixed(2)), recordedAt: ts, source: SOURCE, sourceMessageId: null });
    // 活動 kcal 300–600
    inserts.push({ metricType: "active_kcal_daily", value: Math.round(rand(300, 600)), recordedAt: ts, source: SOURCE, sourceMessageId: null });
    // 基礎 kcal 1500–1800
    inserts.push({ metricType: "basal_kcal_daily", value: Math.round(rand(1500, 1800)), recordedAt: ts, source: SOURCE, sourceMessageId: null });
    // 運動分 20–60
    inserts.push({ metricType: "exercise_min_daily", value: Math.round(rand(20, 60)), recordedAt: ts, source: SOURCE, sourceMessageId: null });
    // スタンド 9–14h
    inserts.push({ metricType: "stand_hours_daily", value: Math.round(rand(9, 14)), recordedAt: ts, source: SOURCE, sourceMessageId: null });
    // 睡眠 6–8h
    inserts.push({ metricType: "sleep_hours_daily", value: Number(rand(6, 8).toFixed(1)), recordedAt: ts, source: SOURCE, sourceMessageId: null });
  }

  // 安静時心拍 (1 件/日)
  for (let d = 0; d <= 6; d++) {
    const ts = jstDayEnd(d);
    inserts.push({
      metricType: "resting_hr",
      value: Math.round(rand(58, 68)),
      recordedAt: new Date(ts.getTime() - 16 * 60 * 60 * 1000), // 朝の値想定
      source: SOURCE,
      sourceMessageId: null,
    });
  }

  // 心拍 (今日の中で 5 点)
  const todayEnd = jstDayEnd(0);
  for (let i = 0; i < 5; i++) {
    inserts.push({
      metricType: "heart_rate",
      value: Math.round(rand(70, 110)),
      recordedAt: new Date(todayEnd.getTime() - (4 - i) * 90 * 60 * 1000),
      source: SOURCE,
      sourceMessageId: null,
    });
  }

  // SpO₂ (今日 1 件)
  inserts.push({
    metricType: "spo2",
    value: Number(rand(96, 99).toFixed(1)),
    recordedAt: new Date(todayEnd.getTime() - 12 * 60 * 60 * 1000),
    source: SOURCE,
    sourceMessageId: null,
  });

  // 一旦既存 mock 削除してから INSERT (べき等)
  await clear();
  await db.insert(bodyMetrics).values(inserts);
  console.log(`Inserted ${inserts.length} mock rows (source=${SOURCE}, 7 days).`);
}

async function main() {
  const arg = process.argv[2];
  if (arg === "--clear") {
    await clear();
  } else {
    await seed();
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
