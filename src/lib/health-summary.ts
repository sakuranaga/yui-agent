/**
 * Yui tool `get_food_summary` / `get_workout_history` の実装。
 * 食事 / 体重 / 気分 / 筋トレ のサマリーを「Yui がそのまま読める短い文字列」で返す。
 *
 * 設計: docs/health-tracking.md §0 領域マップ (各 get_* tool)
 */
import { db } from "@/db/client";
import { foodLogs, bodyMetrics, workoutLogs } from "@/db/schema";
import { and, gte, lt, eq, desc, asc } from "drizzle-orm";

type Range =
  | "today"
  | "recent_weight"
  | "recent_mood"
  | "today_activity"   // 今日の歩数・活動 kcal・運動分
  | "recent_steps"     // 直近 7 日の歩数推移
  | "recent_hr";       // 直近 7 件の安静時心拍

export async function summarizeHealth(range: Range): Promise<string> {
  switch (range) {
    case "today": return await summarizeToday();
    case "recent_weight": return await summarizeRecentMetric("weight_kg", "kg", 7);
    case "recent_mood": return await summarizeRecentMetric("mood_1to5", "(1-5)", 7);
    case "today_activity": return await summarizeTodayActivity();
    case "recent_steps": return await summarizeRecentMetric("steps_daily", "歩", 7);
    case "recent_hr": return await summarizeRecentMetric("resting_hr", "bpm", 7);
  }
}

type WorkoutRange = "last" | "recent" | "today";

/**
 * Yui tool `get_workout_history` の実装。
 * - last  : 直近 1 件 (= 「昨日上半身だったから今日は下半身どう？」用)
 * - recent: 直近 7 件 (= 部位の偏り判定)
 * - today : 今日 (= 今日トレした？確認用)
 */
export async function summarizeWorkout(range: WorkoutRange): Promise<string> {
  if (range === "today") return await summarizeWorkoutToday();
  if (range === "last") return await summarizeWorkoutLast();
  return await summarizeWorkoutRecent();
}

function jstDayBounds(): { start: Date; end: Date; ymd: string } {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(new Date());
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const ymd = `${g("year")}-${g("month")}-${g("day")}`;
  const start = new Date(`${ymd}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end, ymd };
}

async function summarizeToday(): Promise<string> {
  const { start, end, ymd } = jstDayBounds();
  const logs = await db
    .select()
    .from(foodLogs)
    .where(and(gte(foodLogs.eatenAt, start), lt(foodLogs.eatenAt, end)))
    .orderBy(asc(foodLogs.eatenAt));
  if (logs.length === 0) return `${ymd} 今日はまだ食事の記録がありません。`;
  let totalKcal = 0, totalP = 0, totalC = 0, totalF = 0;
  let allKnown = true;
  const lines: string[] = [];
  for (const l of logs) {
    if (l.totalKcal === null) allKnown = false;
    else {
      totalKcal += l.totalKcal;
      totalP += l.totalProtein ?? 0;
      totalC += l.totalCarbs ?? 0;
      totalF += l.totalFat ?? 0;
    }
    const items = (l.items as Array<{ name: string; quantity?: number; unit?: string; kcal?: number | null }>) ?? [];
    const itemText = items.map((it) => {
      const q = it.quantity ?? 1;
      const u = it.unit ?? "";
      const k = typeof it.kcal === "number" ? `${Math.round(it.kcal)} kcal` : "—";
      return `${it.name} ${q}${u} (${k})`;
    }).join("、");
    const time = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
    }).format(l.eatenAt);
    lines.push(`- ${time} ${itemText}`);
  }
  const head = allKnown
    ? `${ymd} 合計 ${Math.round(totalKcal)} kcal (P ${totalP.toFixed(1)}g / C ${totalC.toFixed(1)}g / F ${totalF.toFixed(1)}g)`
    : `${ymd} 合計 ${Math.round(totalKcal)} kcal (一部不明あり)`;
  return `${head}\n${lines.join("\n")}`;
}

async function summarizeTodayActivity(): Promise<string> {
  const { start, end, ymd } = jstDayBounds();
  // 当日 (JST) の各種日次活動メトリクスを集約
  const rows = await db
    .select()
    .from(bodyMetrics)
    .where(and(gte(bodyMetrics.recordedAt, start), lt(bodyMetrics.recordedAt, end)))
    .orderBy(desc(bodyMetrics.recordedAt));
  const pick = (type: string) => rows.find((r) => r.metricType === type)?.value;
  const steps = pick("steps_daily");
  const activeKcal = pick("active_kcal_daily");
  const exerciseMin = pick("exercise_min_daily");
  const standHours = pick("stand_hours_daily");
  const distance = pick("distance_km_daily");
  const restingHr = pick("resting_hr");
  if (steps === undefined && activeKcal === undefined && exerciseMin === undefined) {
    return `${ymd} 今日の活動データはまだ届いていません。`;
  }
  const parts: string[] = [];
  if (steps !== undefined) parts.push(`歩数 ${Math.round(steps).toLocaleString()} 歩`);
  if (distance !== undefined) parts.push(`距離 ${distance.toFixed(2)} km`);
  if (activeKcal !== undefined) parts.push(`活動 ${Math.round(activeKcal)} kcal`);
  if (exerciseMin !== undefined) parts.push(`運動 ${Math.round(exerciseMin)} 分`);
  if (standHours !== undefined) parts.push(`スタンド ${Math.round(standHours)} h`);
  if (restingHr !== undefined) parts.push(`安静時心拍 ${Math.round(restingHr)} bpm`);
  return `${ymd}\n- ${parts.join(" / ")}`;
}

async function summarizeRecentMetric(
  metricType: string,
  unit: string,
  limit: number
): Promise<string> {
  const rows = await db
    .select()
    .from(bodyMetrics)
    .where(eq(bodyMetrics.metricType, metricType))
    .orderBy(desc(bodyMetrics.recordedAt))
    .limit(limit);
  if (rows.length === 0) return `${metricType} のデータがまだありません。`;
  const lines = rows.map((r) => {
    const t = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
    }).format(r.recordedAt);
    return `- ${t}: ${r.value} ${unit}`;
  });
  // 推移 (新値 - 旧値) を 1 行追記
  if (rows.length >= 2) {
    const newest = rows[0].value;
    const oldest = rows[rows.length - 1].value;
    const delta = newest - oldest;
    const sign = delta > 0 ? "+" : "";
    lines.push(`直近 ${rows.length} 件で ${sign}${delta.toFixed(1)} ${unit} の変化`);
  }
  return lines.join("\n");
}

const BODY_PART_JA: Record<string, string> = {
  chest: "胸", back: "背中", shoulders: "肩", legs: "脚",
  arms: "腕", core: "体幹", cardio: "有酸素", full: "全身",
};
function bodyPartsJa(parts: unknown): string {
  if (!Array.isArray(parts)) return "—";
  return parts.map((p) => BODY_PART_JA[String(p)] ?? String(p)).join("・");
}
function fmtDateMd(d: Date): string {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
  }).format(d);
}
function exercisesShort(ex: unknown): string {
  if (!Array.isArray(ex) || ex.length === 0) return "";
  return ex.slice(0, 4).map((e) => {
    const o = e as { name?: string; sets?: number; reps?: number; weight_kg?: number; distance_km?: number };
    let s = o.name ?? "";
    if (typeof o.weight_kg === "number") s += ` ${o.weight_kg}kg`;
    if (typeof o.sets === "number" && typeof o.reps === "number") s += ` ${o.sets}x${o.reps}`;
    if (typeof o.distance_km === "number") s += ` ${o.distance_km}km`;
    return s;
  }).join("、");
}

async function summarizeWorkoutToday(): Promise<string> {
  const { start, end, ymd } = jstDayBounds();
  const rows = await db
    .select()
    .from(workoutLogs)
    .where(and(gte(workoutLogs.performedAt, start), lt(workoutLogs.performedAt, end)))
    .orderBy(asc(workoutLogs.performedAt));
  if (rows.length === 0) return `${ymd} 今日はまだ運動の記録がありません。`;
  const lines = rows.map((w) => {
    const parts = bodyPartsJa(w.bodyParts);
    const ex = exercisesShort(w.exercises);
    return `- ${parts}${ex ? " (" + ex + ")" : ""}${w.intensity ? ` [${w.intensity}]` : ""}`;
  });
  return `${ymd}\n${lines.join("\n")}`;
}

async function summarizeWorkoutLast(): Promise<string> {
  const rows = await db
    .select()
    .from(workoutLogs)
    .orderBy(desc(workoutLogs.performedAt))
    .limit(1);
  if (rows.length === 0) return "運動の記録がまだありません。";
  const w = rows[0];
  const md = fmtDateMd(w.performedAt);
  const parts = bodyPartsJa(w.bodyParts);
  const ex = exercisesShort(w.exercises);
  return `直近の運動: ${md} ${parts}${ex ? " (" + ex + ")" : ""}${w.intensity ? ` [${w.intensity}]` : ""}`;
}

async function summarizeWorkoutRecent(): Promise<string> {
  const rows = await db
    .select()
    .from(workoutLogs)
    .orderBy(desc(workoutLogs.performedAt))
    .limit(7);
  if (rows.length === 0) return "運動の記録がまだありません。";
  const lines = rows.map((w) => {
    const md = fmtDateMd(w.performedAt);
    const parts = bodyPartsJa(w.bodyParts);
    return `- ${md} ${parts}`;
  });
  // 部位の集計 (どこが偏ってる / 抜けてる)
  const partCount: Record<string, number> = {};
  for (const w of rows) {
    if (!Array.isArray(w.bodyParts)) continue;
    for (const p of w.bodyParts) {
      const k = String(p);
      partCount[k] = (partCount[k] ?? 0) + 1;
    }
  }
  const partSummary = Object.entries(partCount)
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => `${BODY_PART_JA[k] ?? k}×${v}`)
    .join(" ");
  return `直近 ${rows.length} 件:\n${lines.join("\n")}\n部位内訳: ${partSummary}`;
}
