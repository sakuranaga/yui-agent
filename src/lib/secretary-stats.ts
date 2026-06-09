/**
 * 秘書 (Yui) のステータスを 1 オブジェクトにまとめて返す。
 *
 * - SecretaryCard が UI 表示に使う (経由: /api/secretary/stats)
 * - Yui 自身が tool 経由でも参照する (get_my_status tool)
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { likeEvents, personaSettings } from "@/db/schema";
import { getTotalXp, levelFromTotalXp } from "@/lib/xp";
import { sumCostUsd } from "@/lib/llm-events-db";

const USD_JPY = Number(process.env.SECRETARY_USD_JPY ?? "150");

function startOfMonthJstMs(): number {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const y = parts.find((p) => p.type === "year")?.value ?? "2026";
  const m = parts.find((p) => p.type === "month")?.value ?? "01";
  // JST 1 日 0:00 = UTC 前日 15:00
  return Date.UTC(Number(y), Number(m) - 1, 1, -9, 0, 0);
}

export type SecretaryStats = {
  name: string;
  level: number;
  xpInCurrentLevel: number;
  xpForNextLevel: number;
  totalXp: number;
  salaryJpyTotal: number;
  salaryJpyMonth: number;
  heartCount: number;
};

export async function collectSecretaryStats(): Promise<SecretaryStats> {
  // 5 クエリは全て独立。直列で ~200ms かかっていたのを並列化。
  // SecretaryCard が UI で頻繁に poll するエンドポイントなので体感に効く。
  const monthStartMs = startOfMonthJstMs();
  const [persona, totalXp, costUsdTotal, costUsdMonth, heart] = await Promise.all([
    db.select({ name: personaSettings.secretaryName }).from(personaSettings).limit(1),
    getTotalXp(),
    sumCostUsd(),
    sumCostUsd({ fromTs: monthStartMs }),
    db.select({ c: sql<number>`count(*)::int` }).from(likeEvents),
  ]);
  const name = persona[0]?.name ?? "結衣";
  const lv = levelFromTotalXp(totalXp);
  const salaryJpyTotal = Math.round(costUsdTotal * USD_JPY);
  const salaryJpyMonth = Math.round(costUsdMonth * USD_JPY);
  const heartCount = heart[0]?.c ?? 0;

  return {
    name,
    level: lv.level,
    xpInCurrentLevel: lv.xpInCurrentLevel,
    xpForNextLevel: lv.xpForNextLevel,
    totalXp: lv.totalXp,
    salaryJpyTotal,
    salaryJpyMonth,
    heartCount,
  };
}
