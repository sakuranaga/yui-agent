/**
 * ヘルス目標 (Health Goals) の CRUD + 評価ロジック。
 *
 * 設計: docs/health-goals.md
 *
 * 3 kind:
 *  - one_time_by_date : 期限付き到達目標 (例: 65kg by 2026-08-31)
 *  - daily_min        : 毎日達成下限 (例: 10,000 歩、タンパク質 100g)
 *  - daily_max        : 毎日超過禁止 (例: 食事 2,000 kcal 未満)
 */
import { db } from "@/db/client";
import {
  healthGoals,
  bodyMetrics,
  foodLogs,
  type HealthGoal,
  type NewHealthGoal,
} from "@/db/schema";
import { and, asc, desc, eq, gte, lt } from "drizzle-orm";

// ───── 公開型 ─────

export type GoalKind = "one_time_by_date" | "daily_min" | "daily_max";

/** 評価結果 (kind ごとに違うので discriminated union)。 */
export type GoalStatus =
  | {
      kind: "one_time_by_date";
      current: number | null;
      target: number;
      baseline: number | null;
      remaining: number | null;
      progressPct: number | null;
      daysLeft: number;
      pace: "ok" | "behind" | "ahead" | "fail" | "achieved" | "unknown";
    }
  | {
      kind: "daily_min";
      today: number | null;
      target: number;
      achieved: boolean;
      ratio: number | null;
      remaining: number | null;
    }
  | {
      kind: "daily_max";
      today: number | null;
      cap: number;
      exceeded: boolean;
      ratio: number | null;
      remaining: number | null;
      zone: "green" | "yellow" | "red" | "unknown";
    };

// metric_key と source タイプの mapping
export const DAILY_BODY_METRIC_TYPES = new Set([
  "steps_daily", "active_kcal_daily", "basal_kcal_daily",
  "exercise_min_daily", "stand_hours_daily", "distance_km_daily",
  "sleep_hours_daily",
]);
export const POINT_BODY_METRIC_TYPES = new Set([
  "weight_kg", "body_fat_pct", "resting_hr", "heart_rate", "spo2",
]);
export const FOOD_AGG_METRIC_KEYS = new Set([
  "kcal_daily_total", "protein_daily_total", "carbs_daily_total",
  "fat_daily_total", "fiber_daily_total",
]);

const VALID_KINDS: GoalKind[] = ["one_time_by_date", "daily_min", "daily_max"];

// ───── CRUD ─────

export async function listGoals(opts: { enabledOnly?: boolean } = {}): Promise<HealthGoal[]> {
  const rows = await db
    .select()
    .from(healthGoals)
    .where(opts.enabledOnly ? eq(healthGoals.enabled, true) : undefined)
    .orderBy(asc(healthGoals.kind), desc(healthGoals.createdAt));
  return rows;
}

export async function getGoal(id: number): Promise<HealthGoal | null> {
  const rows = await db.select().from(healthGoals).where(eq(healthGoals.id, id)).limit(1);
  return rows[0] ?? null;
}

export type GoalInput = {
  metric_key: string;
  kind: GoalKind;
  target_value: number;
  baseline_value?: number | null;
  deadline?: string | null;          // YYYY-MM-DD
  start_date?: string | null;         // YYYY-MM-DD、省略時は今日
  label?: string | null;
  notes?: string | null;
  enabled?: boolean;
};

function ymdToDate(ymd: string): Date {
  return new Date(`${ymd}T00:00:00+09:00`);
}

export async function createGoal(input: GoalInput): Promise<HealthGoal> {
  if (!VALID_KINDS.includes(input.kind)) throw new Error(`invalid kind: ${input.kind}`);
  if (typeof input.metric_key !== "string" || input.metric_key.length === 0)
    throw new Error("metric_key required");
  if (typeof input.target_value !== "number" || !Number.isFinite(input.target_value))
    throw new Error("target_value required (number)");
  if (input.kind === "one_time_by_date" && !input.deadline) {
    throw new Error("deadline required for one_time_by_date");
  }

  // one_time_by_date で baseline 未指定なら、最新の metric 値を baseline にする
  let baseline = input.baseline_value ?? null;
  if (input.kind === "one_time_by_date" && baseline === null) {
    const cur = await currentValue(input.metric_key, new Date());
    if (cur !== null) baseline = cur;
  }

  const values: NewHealthGoal = {
    metricKey: input.metric_key,
    kind: input.kind,
    targetValue: input.target_value,
    baselineValue: baseline,
    deadline: input.deadline ? ymdToDate(input.deadline) : null,
    startDate: input.start_date ? ymdToDate(input.start_date) : new Date(),
    label: input.label ?? null,
    notes: input.notes ?? null,
    enabled: input.enabled ?? true,
  };
  const inserted = await db.insert(healthGoals).values(values).returning();
  return inserted[0];
}

export type GoalUpdate = Partial<GoalInput> & { achieved_at?: string | null };

export async function updateGoal(id: number, update: GoalUpdate): Promise<HealthGoal | null> {
  const setValues: Record<string, unknown> = { updatedAt: new Date() };
  if (update.metric_key !== undefined) setValues.metricKey = update.metric_key;
  if (update.kind !== undefined) {
    if (!VALID_KINDS.includes(update.kind)) throw new Error(`invalid kind: ${update.kind}`);
    setValues.kind = update.kind;
  }
  if (update.target_value !== undefined) setValues.targetValue = update.target_value;
  if (update.baseline_value !== undefined) setValues.baselineValue = update.baseline_value;
  if (update.deadline !== undefined)
    setValues.deadline = update.deadline ? ymdToDate(update.deadline) : null;
  if (update.start_date !== undefined)
    setValues.startDate = update.start_date ? ymdToDate(update.start_date) : new Date();
  if (update.label !== undefined) setValues.label = update.label;
  if (update.notes !== undefined) setValues.notes = update.notes;
  if (update.enabled !== undefined) setValues.enabled = update.enabled;
  if (update.achieved_at !== undefined)
    setValues.achievedAt = update.achieved_at ? new Date(update.achieved_at) : null;

  const updated = await db
    .update(healthGoals)
    .set(setValues)
    .where(eq(healthGoals.id, id))
    .returning();
  return updated[0] ?? null;
}

export async function deleteGoal(id: number): Promise<boolean> {
  const deleted = await db.delete(healthGoals).where(eq(healthGoals.id, id)).returning();
  return deleted.length > 0;
}

// ───── 評価 ─────

/** metric_key の「今 (or 指定日)」の値を取得 (体重なら全期間最新)。 */
export async function currentValue(
  metricKey: string,
  asOf: Date = new Date()
): Promise<number | null> {
  const bounds = jstDayBoundsOf(jstYmdOf(asOf));

  if (DAILY_BODY_METRIC_TYPES.has(metricKey)) {
    // その日 (JST) の値を取る (= HealthKit 取り込み済の同日 1 行)
    const rows = await db
      .select()
      .from(bodyMetrics)
      .where(
        and(
          eq(bodyMetrics.metricType, metricKey),
          gte(bodyMetrics.recordedAt, bounds.start),
          lt(bodyMetrics.recordedAt, bounds.end)
        )
      )
      .orderBy(desc(bodyMetrics.recordedAt))
      .limit(1);
    return rows[0]?.value ?? null;
  }

  if (POINT_BODY_METRIC_TYPES.has(metricKey)) {
    // 全期間で最新値 (体重・体脂肪は日々測らないので)
    const rows = await db
      .select()
      .from(bodyMetrics)
      .where(eq(bodyMetrics.metricType, metricKey))
      .orderBy(desc(bodyMetrics.recordedAt))
      .limit(1);
    return rows[0]?.value ?? null;
  }

  if (FOOD_AGG_METRIC_KEYS.has(metricKey)) {
    // food_logs その日 SUM
    const rows = await db
      .select()
      .from(foodLogs)
      .where(and(gte(foodLogs.eatenAt, bounds.start), lt(foodLogs.eatenAt, bounds.end)));
    let sum = 0;
    for (const r of rows) {
      if (metricKey === "kcal_daily_total") sum += r.totalKcal ?? 0;
      else if (metricKey === "protein_daily_total") sum += r.totalProtein ?? 0;
      else if (metricKey === "carbs_daily_total") sum += r.totalCarbs ?? 0;
      else if (metricKey === "fat_daily_total") sum += r.totalFat ?? 0;
      else if (metricKey === "fiber_daily_total") sum += r.totalFiber ?? 0;
    }
    return sum;
  }

  return null;
}

export async function evaluateGoal(
  goal: HealthGoal,
  asOf: Date = new Date()
): Promise<GoalStatus> {
  if (goal.kind === "one_time_by_date") {
    const current = await currentValue(goal.metricKey, asOf);
    const target = goal.targetValue;
    const baseline = goal.baselineValue;
    const deadline = goal.deadline;
    const start = goal.startDate;

    const daysLeft = deadline
      ? Math.ceil((deadline.getTime() - asOf.getTime()) / (24 * 60 * 60 * 1000))
      : 0;

    // 既達成 (achieved_at set済) なら ok
    if (goal.achievedAt) {
      return {
        kind: "one_time_by_date",
        current, target, baseline,
        remaining: 0,
        progressPct: 100,
        daysLeft,
        pace: "achieved",
      };
    }
    if (current === null) {
      return {
        kind: "one_time_by_date",
        current, target, baseline,
        remaining: null, progressPct: null,
        daysLeft, pace: "unknown",
      };
    }
    // 達成判定: 減らす目標 (target < baseline) なら current <= target、増やすなら current >= target
    const reducing = baseline !== null && baseline > target;
    const achieved = reducing ? current <= target : current >= target;

    // 進捗率
    let progressPct: number | null = null;
    if (baseline !== null && baseline !== target) {
      progressPct = ((baseline - current) / (baseline - target)) * 100;
      if (!reducing) progressPct = ((current - baseline) / (target - baseline)) * 100;
      progressPct = Math.max(0, Math.min(100, progressPct));
    }

    // pace
    type Pace = "ok" | "behind" | "ahead" | "fail" | "achieved" | "unknown";
    let pace: Pace = "unknown";
    if (achieved) pace = "achieved";
    else if (daysLeft < 0) pace = "fail";
    else if (deadline && start && progressPct !== null) {
      const totalDays = Math.max(
        1,
        Math.ceil((deadline.getTime() - start.getTime()) / (24 * 60 * 60 * 1000))
      );
      const elapsedDays = Math.max(0, totalDays - daysLeft);
      const expectedPct = (elapsedDays / totalDays) * 100;
      if (progressPct >= expectedPct + 5) pace = "ahead";
      else if (progressPct >= expectedPct - 5) pace = "ok";
      else pace = "behind";
    }

    return {
      kind: "one_time_by_date",
      current, target, baseline,
      remaining: reducing ? Math.max(0, current - target) : Math.max(0, target - current),
      progressPct,
      daysLeft,
      pace,
    };
  }

  if (goal.kind === "daily_min") {
    const today = await currentValue(goal.metricKey, asOf);
    const target = goal.targetValue;
    if (today === null) {
      return {
        kind: "daily_min",
        today, target,
        achieved: false, ratio: null, remaining: null,
      };
    }
    return {
      kind: "daily_min",
      today, target,
      achieved: today >= target,
      ratio: today / target,
      remaining: Math.max(0, target - today),
    };
  }

  // daily_max
  const today = await currentValue(goal.metricKey, asOf);
  const cap = goal.targetValue;
  if (today === null) {
    return {
      kind: "daily_max",
      today, cap,
      exceeded: false, ratio: null, remaining: null,
      zone: "unknown",
    };
  }
  const ratio = today / cap;
  let zone: "green" | "yellow" | "red" = "green";
  if (ratio > 1) zone = "red";
  else if (ratio > 0.8) zone = "yellow";
  return {
    kind: "daily_max",
    today, cap,
    exceeded: today > cap,
    ratio,
    remaining: Math.max(0, cap - today),
    zone,
  };
}

/**
 * 全 enabled 目標を評価して 1 リストで返す (Yui env block / UI 共通)。
 * 各 element に goal 本体 + status を結合。
 * one_time が今回の評価で達成判定されたら achieved_at を SET (副作用)。
 */
export type EvaluatedGoal = { goal: HealthGoal; status: GoalStatus };

export async function evaluateAllEnabled(asOf: Date = new Date()): Promise<EvaluatedGoal[]> {
  const goals = await listGoals({ enabledOnly: true });
  const out: EvaluatedGoal[] = [];
  for (const g of goals) {
    const status = await evaluateGoal(g, asOf);
    out.push({ goal: g, status });
    // one_time の自動 achieved 判定 (副作用)
    if (
      status.kind === "one_time_by_date" &&
      status.pace === "achieved" &&
      !g.achievedAt
    ) {
      try {
        await db
          .update(healthGoals)
          .set({ achievedAt: asOf, updatedAt: asOf })
          .where(eq(healthGoals.id, g.id));
      } catch (e) {
        console.warn("[health-goals] auto-achieved set failed:", e);
      }
    }
  }
  return out;
}

// ───── env block 用 サマリ整形 ─────

/**
 * Yui env block / system prompt 用の「今日の目標サマリ」を 1 段落で返す。
 * 0 件なら空文字。
 */
export async function summarizeGoalsForEnv(asOf: Date = new Date()): Promise<string> {
  const all = await evaluateAllEnabled(asOf);
  if (all.length === 0) return "";

  const lines: string[] = [`## 今日の目標 (${all.length} 件 有効中)`];
  for (const { goal, status } of all) {
    const label = goal.label ?? `${metricLabel(goal.metricKey)} ${goal.targetValue}`;
    if (status.kind === "one_time_by_date") {
      if (status.pace === "achieved") {
        lines.push(`- ✓ 達成済: ${label}`);
      } else if (status.current === null) {
        lines.push(`- [目標] ${label} (測定値なし)`);
      } else {
        const pct = status.progressPct !== null ? `${Math.round(status.progressPct)}%` : "?";
        const paceLabel = {
          ok: "ペース順調", behind: "やや遅れ気味", ahead: "ペース上回ってる",
          fail: "期限超過", achieved: "達成", unknown: "?",
        }[status.pace];
        lines.push(`- [目標] ${label}: 現在 ${formatNum(status.current)} (${pct}, 残り ${status.daysLeft} 日, ${paceLabel})`);
      }
    } else if (status.kind === "daily_min") {
      const t = status.today === null ? "未測定" : formatNum(status.today);
      const r = status.ratio !== null ? Math.round(status.ratio * 100) : null;
      const mark = status.achieved ? "✓" : "○";
      lines.push(`- ${mark} ${label}: 今日 ${t} / ${goal.targetValue}${r !== null ? ` (${r}%)` : ""}${status.remaining ? `, 残り ${formatNum(status.remaining)}` : ""}`);
    } else {
      const t = status.today === null ? "未測定" : formatNum(status.today);
      const r = status.ratio !== null ? Math.round(status.ratio * 100) : null;
      const mark = status.zone === "red" ? "🚨" : status.zone === "yellow" ? "⚠️" : "🟢";
      lines.push(`- ${mark} ${label}: 今日 ${t} / 上限 ${goal.targetValue}${r !== null ? ` (${r}%)` : ""}${status.exceeded ? ` 超過 ${formatNum(-(status.remaining ?? 0))}` : `, 残り ${formatNum(status.remaining ?? 0)}`}`);
    }
  }
  return lines.join("\n");
}

// ───── helpers ─────

const METRIC_LABEL: Record<string, string> = {
  weight_kg: "体重", body_fat_pct: "体脂肪率",
  steps_daily: "歩数", active_kcal_daily: "活動 kcal",
  basal_kcal_daily: "基礎代謝 kcal", exercise_min_daily: "運動分",
  stand_hours_daily: "スタンド h", distance_km_daily: "距離 km",
  sleep_hours_daily: "睡眠 h",
  resting_hr: "安静時心拍", heart_rate: "心拍", spo2: "SpO₂",
  kcal_daily_total: "食事 kcal", protein_daily_total: "タンパク質",
  carbs_daily_total: "炭水化物", fat_daily_total: "脂質",
  fiber_daily_total: "食物繊維",
};
export function metricLabel(key: string): string {
  return METRIC_LABEL[key] ?? key;
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  if (Math.abs(n) >= 100) return Math.round(n).toString();
  return Number(n.toFixed(1)).toString();
}

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
