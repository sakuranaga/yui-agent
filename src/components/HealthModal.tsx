"use client";

/**
 * ヘルスモーダル — 食事 / 体重 / 気分 / 運動 / HealthKit を集約する hub。
 *
 * 設計: docs/health-tracking.md
 *
 * Phase 2 ✓ ヘルスモーダル + 体重 / 気分 + get_food_summary tool
 * Phase 3 ✓ 運動 (workout_logs) + 部位 chip
 * Phase 5 ✓ HealthKit 活動 tile / sparkline / HR
 * Phase 6 ← 今: 日次/週次/月次 view + 日付 ◀ ▶ nav + 期間別チャート
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";
import HealthGoalsModal from "./HealthGoalsModal";

type FoodItem = {
  name: string;
  quantity?: number;
  unit?: string;
  kcal?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
  fiber?: number | null;
  salt?: number | null;
};
type FoodLogEntry = {
  id: number;
  eatenAt: string;
  items: FoodItem[];
  totalKcal: number | null;
  totalProtein: number | null;
  totalCarbs: number | null;
  totalFat: number | null;
  totalFiber: number | null;
  totalSalt: number | null;
  confidence: number;
};
type WorkoutLog = {
  id: number;
  performedAt: string;
  bodyParts: string[];
  exercises: Array<{ name?: string; sets?: number; reps?: number; weight_kg?: number; distance_km?: number; duration_min?: number }>;
  durationMin: number | null;
  intensity: "light" | "normal" | "hard" | null;
  notes: string | null;
};
type RangeResp = {
  mode: "day" | "week" | "month";
  date: string;
  startYmd: string;
  endYmd: string;
  ymdList: string[];
  foods: FoodLogEntry[];
  workouts: WorkoutLog[];
  activityDaily: Record<string, Record<string, number>>;       // type → ymd → value
  scalarDaily: Record<string, Record<string, number>>;          // weight_kg/body_fat_pct/mood_1to5 → ymd → value
  scalarPoints: Array<{ id: number; metricType: string; value: number; recordedAt: string }>;
  points: Array<{ metricType: string; value: number; recordedAt: string }>;
  foodDaily: Record<string, { kcal: number; count: number; hasUnknown: boolean }>;
  workoutDaily: Record<string, { count: number; bodyParts: string[] }>;
};
type ActivityResp = {
  date: string;
  today: Record<string, number>;
  sparklines: Record<string, Array<{ ymd: string; value: number }>>;
  recentPoints: Record<string, Array<{ value: number; recordedAt: string }>>;
  lastSync: string | null;
};
type WeightMetric = { id: number; value: number; recordedAt: string };

type GoalEval = {
  goal: {
    id: number;
    metricKey: string;
    kind: "one_time_by_date" | "daily_min" | "daily_max";
    targetValue: number;
    deadline: string | null;
    label: string | null;
  };
  status:
    | { kind: "one_time_by_date"; current: number | null; target: number; baseline: number | null;
        remaining: number | null; progressPct: number | null; daysLeft: number;
        pace: "ok" | "behind" | "ahead" | "fail" | "achieved" | "unknown" }
    | { kind: "daily_min"; today: number | null; target: number; achieved: boolean;
        ratio: number | null; remaining: number | null }
    | { kind: "daily_max"; today: number | null; cap: number; exceeded: boolean;
        ratio: number | null; remaining: number | null; zone: "green" | "yellow" | "red" | "unknown" };
};

const DAILY_TILES: Array<{ key: string; label: string; unit: string; fmt: (v: number) => string }> = [
  { key: "steps_daily",        label: "歩数",     unit: "歩",   fmt: (v) => Math.round(v).toLocaleString() },
  { key: "distance_km_daily",  label: "距離",     unit: "km",   fmt: (v) => v.toFixed(2) },
  { key: "active_kcal_daily",  label: "活動",     unit: "kcal", fmt: (v) => Math.round(v).toString() },
  { key: "basal_kcal_daily",   label: "基礎",     unit: "kcal", fmt: (v) => Math.round(v).toString() },
  { key: "exercise_min_daily", label: "運動",     unit: "分",   fmt: (v) => Math.round(v).toString() },
  { key: "stand_hours_daily",  label: "スタンド", unit: "h",    fmt: (v) => Math.round(v).toString() },
  { key: "sleep_hours_daily",  label: "睡眠",     unit: "h",    fmt: (v) => v.toFixed(1) },
];

const SPARK_TYPES: Array<{ key: string; label: string; unit: string }> = [
  { key: "steps_daily",        label: "歩数",       unit: "歩" },
  { key: "active_kcal_daily",  label: "活動 kcal", unit: "kcal" },
  { key: "exercise_min_daily", label: "運動 分",    unit: "分" },
  { key: "sleep_hours_daily",  label: "睡眠 h",     unit: "h" },
];

const BODY_PARTS: Array<{ key: string; label: string }> = [
  { key: "chest", label: "胸" },
  { key: "back", label: "背中" },
  { key: "shoulders", label: "肩" },
  { key: "arms", label: "腕" },
  { key: "legs", label: "脚" },
  { key: "core", label: "体幹" },
  { key: "cardio", label: "有酸素" },
  { key: "full", label: "全身" },
];

type ViewMode = "day" | "week" | "month";
type Props = { open: boolean; onClose: () => void };

function jstYmdOf(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function jstYmdToday(): string {
  return jstYmdOf(new Date());
}

function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd}T00:00:00+09:00`);
  d.setUTCDate(d.getUTCDate() + days);
  return jstYmdOf(d);
}

function shiftMonth(ymd: string, months: number): string {
  const d = new Date(`${ymd}T00:00:00+09:00`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return jstYmdOf(d);
}

function fmtRangeLabel(mode: ViewMode, startYmd: string, endYmd: string): string {
  if (mode === "day") {
    const d = new Date(`${startYmd}T00:00:00+09:00`);
    return d.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  }
  if (mode === "week") {
    const s = new Date(`${startYmd}T00:00:00+09:00`);
    const e = new Date(`${endYmd}T00:00:00+09:00`);
    return `${s.getMonth() + 1}/${s.getDate()} – ${e.getMonth() + 1}/${e.getDate()}`;
  }
  // month
  const s = new Date(`${startYmd}T00:00:00+09:00`);
  return `${s.getFullYear()}年 ${s.getMonth() + 1}月`;
}

const Chevron = ({ left }: { left: boolean }) => (
  <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
    {left ? <polyline points="15 18 9 12 15 6" /> : <polyline points="9 18 15 12 9 6" />}
  </svg>
);

const TargetIcon = ({ size = 14 }: { size?: number } = {}) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="10" />
    <circle cx="12" cy="12" r="6" />
    <circle cx="12" cy="12" r="2" />
  </svg>
);

const GaugeIcon = ({ size = 14 }: { size?: number } = {}) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M12 14l4-4" />
    <path d="M3.34 19a10 10 0 1 1 17.32 0" />
  </svg>
);

const CheckIcon = ({ size = 14 }: { size?: number } = {}) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <polyline points="20 6 9 17 4 12" />
  </svg>
);

const TrophyIcon = ({ size = 14 }: { size?: number } = {}) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M6 9H4a2 2 0 0 1-2-2V5h4" />
    <path d="M18 9h2a2 2 0 0 0 2-2V5h-4" />
    <path d="M6 5h12v5a6 6 0 0 1-12 0V5z" />
    <path d="M12 15v3" />
    <path d="M9 21h6" />
  </svg>
);

export default function HealthModal({ open, onClose }: Props) {
  const { mounted, closing } = useModalTransition(open);
  const [mode, setMode] = useState<ViewMode>("day");
  const [date, setDate] = useState<string>(jstYmdToday());
  const [range, setRange] = useState<RangeResp | null>(null);
  const [activity, setActivity] = useState<ActivityResp | null>(null);
  const [weights, setWeights] = useState<WeightMetric[]>([]);
  const [foodDaily, setFoodDaily] = useState<Array<{ ymd: string; kcal: number; hasUnknown: boolean; count: number }>>([]);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [weightInput, setWeightInput] = useState("");
  const [weightSaving, setWeightSaving] = useState(false);
  const [selectedParts, setSelectedParts] = useState<Set<string>>(new Set());
  const [workoutSaving, setWorkoutSaving] = useState(false);
  const [weightHistoryOpen, setWeightHistoryOpen] = useState(false);
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [goalItems, setGoalItems] = useState<GoalEval[]>([]);

  const loadRange = useCallback(async () => {
    try {
      const res = await fetch(`/api/health/range?mode=${mode}&date=${date}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as RangeResp;
      setRange(data);
    } catch (e) {
      console.warn("[health-modal] range load failed:", e);
    }
  }, [mode, date]);

  const loadActivity = useCallback(async () => {
    try {
      const res = await fetch("/api/health/activity", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as ActivityResp;
      setActivity(data);
    } catch (e) {
      console.warn("[health-modal] activity load failed:", e);
    }
  }, []);

  const loadWeights = useCallback(async () => {
    try {
      const res = await fetch("/api/body-metrics?type=weight_kg&limit=60", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { metrics: WeightMetric[] };
      setWeights(data.metrics);
    } catch (e) {
      console.warn("[health-modal] weight load failed:", e);
    }
  }, []);

  const loadGoals = useCallback(async () => {
    try {
      const res = await fetch("/api/health/goals?withStatus=1", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: GoalEval[] };
      setGoalItems(data.items);
    } catch (e) {
      console.warn("[health-modal] goals load failed:", e);
    }
  }, []);

  const loadFoodDaily = useCallback(async () => {
    try {
      const res = await fetch("/api/food/daily?days=30", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { series: Array<{ ymd: string; kcal: number; hasUnknown: boolean; count: number }> };
      setFoodDaily(data.series);
    } catch (e) {
      console.warn("[health-modal] food daily load failed:", e);
    }
  }, []);

  // モーダル open のたびに「今日 (JST)」へリセット + 各 metric を fetch。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => { if (open) setDate(jstYmdToday()); }, [open]);
  useEffect(() => { if (open) void loadRange(); }, [open, loadRange]);
  useEffect(() => {
    if (!open) return;
    void loadActivity();
    void loadWeights();
    void loadFoodDaily();
    void loadGoals();
  }, [open, loadActivity, loadWeights, loadFoodDaily, loadGoals]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // Esc / body lock
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape" && editingId === null) onClose(); };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, editingId, onClose]);

  // ── date nav ──
  const navStep = (dir: -1 | 1) => {
    if (mode === "day") setDate((d) => shiftYmd(d, dir));
    else if (mode === "week") setDate((d) => shiftYmd(d, dir * 7));
    else setDate((d) => shiftMonth(d, dir));
  };
  const goToday = () => setDate(jstYmdToday());

  // ── editors ──
  const submitWeight = async () => {
    const v = parseFloat(weightInput);
    if (!Number.isFinite(v) || v < 30 || v > 150) {
      alert("体重は 30〜150 kg の範囲で入力してください。");
      return;
    }
    setWeightSaving(true);
    try {
      const res = await fetch("/api/body-metrics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metric_type: "weight_kg", value: v }),
      });
      if (res.ok) {
        setWeightInput("");
        void loadWeights();
        if (mode === "day") void loadRange();
      }
    } finally {
      setWeightSaving(false);
    }
  };

  const deleteWeight = async (id: number) => {
    if (!confirm("この体重記録を削除します。よろしいですか?")) return;
    const res = await fetch(`/api/body-metrics/${id}`, { method: "DELETE" });
    if (res.ok) {
      void loadWeights();
      if (mode === "day") void loadRange();
    }
  };

  const deleteFood = async (id: number) => {
    if (!confirm("この食事ログを削除します。よろしいですか?")) return;
    const res = await fetch(`/api/food/${id}`, { method: "DELETE" });
    if (res.ok) {
      void loadRange();
      void loadFoodDaily();
    }
  };

  const toggleBodyPart = (key: string) => {
    setSelectedParts((cur) => {
      const next = new Set(cur);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };
  const submitWorkout = async () => {
    if (selectedParts.size === 0) return;
    setWorkoutSaving(true);
    try {
      const res = await fetch("/api/workouts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body_parts: Array.from(selectedParts) }),
      });
      if (res.ok) {
        setSelectedParts(new Set());
        void loadRange();
      }
    } finally {
      setWorkoutSaving(false);
    }
  };
  const deleteWorkout = async (id: number) => {
    if (!confirm("この運動ログを削除します。よろしいですか?")) return;
    const res = await fetch(`/api/workouts/${id}`, { method: "DELETE" });
    if (res.ok) void loadRange();
  };

  // ── derived ──
  const summary = useMemo(() => {
    if (!range) return null;
    let kcal = 0, p = 0, c = 0, f = 0, fiber = 0, salt = 0; let unknown = false;
    for (const log of range.foods) {
      if (log.totalKcal === null) { unknown = true; continue; }
      kcal += log.totalKcal;
      p += log.totalProtein ?? 0;
      c += log.totalCarbs ?? 0;
      f += log.totalFat ?? 0;
      fiber += log.totalFiber ?? 0;
      salt += log.totalSalt ?? 0;
    }
    return { kcal, p, c, f, fiber, salt, unknown, count: range.foods.length };
  }, [range]);

  if (!mounted) return null;

  const today = jstYmdToday();
  const rangeLabel = range ? fmtRangeLabel(range.mode, range.startYmd, range.endYmd) : "";

  return (
    <div className={`health-modal-backdrop${closing ? " modal-closing" : ""}`} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`health-modal${closing ? " modal-closing" : ""}`}>
        <button type="button" className="health-modal-close" onClick={onClose} aria-label="閉じる">×</button>
        <header className="health-modal-header">
          <h1>ヘルス</h1>
          <nav className="health-nav" aria-label="日付ナビ">
            <button type="button" className="health-nav-btn" onClick={() => navStep(-1)} aria-label="前へ"><Chevron left /></button>
            <div className="health-nav-date">{rangeLabel || "—"}</div>
            <button
              type="button"
              className="health-nav-btn"
              onClick={() => navStep(1)}
              disabled={date >= today}
              aria-label="次へ"
            ><Chevron left={false} /></button>
            <div className="health-nav-tabs">
              {(["day", "week", "month"] as ViewMode[]).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={`health-nav-tab${mode === m ? " active" : ""}`}
                  onClick={() => setMode(m)}
                >
                  {m === "day" ? "日次" : m === "week" ? "週次" : "月次"}
                </button>
              ))}
            </div>
            <button
              type="button"
              className="health-nav-today"
              onClick={goToday}
              disabled={date === today && mode === "day"}
            >今日</button>
            <button
              type="button"
              className="health-nav-today health-nav-goals"
              onClick={() => setGoalsOpen(true)}
              title="ヘルス目標の管理"
            ><TargetIcon /><span>目標</span></button>
          </nav>
        </header>

        <div className="health-modal-body">
          {range && (mode === "day" ? renderDay() : renderRange())}
        </div>
      </div>
      <HealthGoalsModal
        open={goalsOpen}
        onClose={() => { setGoalsOpen(false); void loadGoals(); }}
      />
    </div>
  );

  // ─────────── 日次 view ───────────
  function renderDay() {
    if (!range) return null;
    return (
      <>
        {/* 活動 (HealthKit) */}
        <section className="health-section health-section-wide">
          <div className="health-section-head">
            <h2>活動 (HealthKit)</h2>
            <span className="health-section-date">
              {activity?.lastSync
                ? `最終取り込み: ${new Date(activity.lastSync).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}`
                : "取り込み実績なし"}
            </span>
          </div>
          {(() => {
            const today: Record<string, number | undefined> = {};
            for (const t of Object.keys(range.activityDaily)) {
              today[t] = range.activityDaily[t][range.startYmd];
            }
            return (
              <div className="health-activity-tiles">
                {DAILY_TILES.map((t) => {
                  const v = today[t.key];
                  const hasValue = v !== undefined;
                  return (
                    <div key={t.key} className={`health-tile${hasValue ? "" : " empty"}`}>
                      <div className="health-tile-label">{t.label}</div>
                      <div className="health-tile-value">
                        {hasValue ? t.fmt(v) : "—"}
                        <span className="health-tile-unit">{t.unit}</span>
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {goalItems.length > 0 && (
            <div className="health-activity-goals">
              <GoalBadge goals={goalItems} metricKey="steps_daily" />
              <GoalBadge goals={goalItems} metricKey="active_kcal_daily" />
              <GoalBadge goals={goalItems} metricKey="exercise_min_daily" />
              <GoalBadge goals={goalItems} metricKey="sleep_hours_daily" />
              <GoalBadge goals={goalItems} metricKey="distance_km_daily" />
            </div>
          )}
          {activity && (
            <div className="health-spark-grid">
              {SPARK_TYPES.filter((s) => (activity.sparklines[s.key]?.length ?? 0) > 0).map((s) => {
                const series = activity.sparklines[s.key];
                const max = Math.max(...series.map((p) => p.value), 1);
                return (
                  <div key={s.key} className="health-spark">
                    <div className="health-spark-head">
                      <span className="health-spark-label">{s.label}</span>
                      <span className="health-spark-range">{series[0]?.ymd.slice(5)}〜{series[series.length - 1]?.ymd.slice(5)}</span>
                    </div>
                    <div className="health-spark-bars">
                      {series.map((p) => (
                        <div
                          key={p.ymd}
                          className="health-spark-bar"
                          style={{ height: `${Math.max((p.value / max) * 100, 4)}%` }}
                          title={`${p.ymd}: ${p.value} ${s.unit}`}
                        />
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
          {activity && (activity.recentPoints.resting_hr?.length > 0 || activity.recentPoints.heart_rate?.length > 0 || activity.recentPoints.spo2?.length > 0) && (
            <div className="health-point-rows">
              {activity.recentPoints.resting_hr?.[0] && (
                <div className="health-point-row">
                  <span className="health-point-label">安静時心拍</span>
                  <span className="health-point-value">{Math.round(activity.recentPoints.resting_hr[0].value)} bpm</span>
                  <span className="health-point-time">
                    {new Date(activity.recentPoints.resting_hr[0].recordedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              )}
              {activity.recentPoints.spo2?.[0] && (
                <div className="health-point-row">
                  <span className="health-point-label">SpO₂</span>
                  <span className="health-point-value">{activity.recentPoints.spo2[0].value.toFixed(1)} %</span>
                  <span className="health-point-time">
                    {new Date(activity.recentPoints.spo2[0].recordedAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                  </span>
                </div>
              )}
              {activity.recentPoints.heart_rate?.length > 0 && (
                <div className="health-point-row health-point-row-wrap">
                  <span className="health-point-label">心拍 (直近)</span>
                  <span className="health-point-hr-list">
                    {activity.recentPoints.heart_rate.slice(0, 5).map((p, i) => (
                      <span key={i} className="health-point-hr-chip">
                        {Math.round(p.value)}
                        <span className="health-point-hr-time">
                          {new Date(p.recordedAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false })}
                        </span>
                      </span>
                    ))}
                  </span>
                </div>
              )}
            </div>
          )}
        </section>

        {/* 食事 */}
        <section className="health-section">
          <div className="health-section-head">
            <h2>食事</h2>
          </div>
          {summary && (
            <div className="health-summary">
              <div className="health-summary-row">
                <span className="health-summary-label">合計</span>
                <span className="health-summary-kcal">
                  <span className="health-summary-kcal-value">{Math.round(summary.kcal).toLocaleString()}</span>
                  <span className="health-summary-kcal-unit">kcal</span>
                  {summary.unknown && <span className="health-summary-warn">(一部不明)</span>}
                </span>
              </div>
              <div className="health-summary-pfc">
                <span>タンパク質 {summary.p.toFixed(1)}g</span>
                <span>炭水化物 {summary.c.toFixed(1)}g</span>
                <span>脂質 {summary.f.toFixed(1)}g</span>
                <span>食物繊維 {summary.fiber.toFixed(1)}g</span>
                <span>食塩 {summary.salt.toFixed(1)}g</span>
              </div>
            </div>
          )}
          <GoalBadge goals={goalItems} metricKey="kcal_daily_total" />
          <GoalBadge goals={goalItems} metricKey="protein_daily_total" />
          <GoalBadge goals={goalItems} metricKey="carbs_daily_total" />
          <GoalBadge goals={goalItems} metricKey="fat_daily_total" />
          <GoalBadge goals={goalItems} metricKey="fiber_daily_total" />
          <KcalBarChart series={foodDaily} />
          {range.foods.length === 0 && <div className="health-empty">この日の食事記録はありません。</div>}
          <div className="health-food-list">
            {range.foods.map((log) => (
              <FoodLogCard
                key={log.id}
                log={log}
                editing={editingId === log.id}
                onEdit={() => setEditingId(log.id)}
                onCancelEdit={() => setEditingId(null)}
                onSaved={() => { setEditingId(null); void loadRange(); }}
                onDelete={() => void deleteFood(log.id)}
              />
            ))}
          </div>
        </section>

        {/* 体重 */}
        <section className="health-section">
          <div className="health-section-head"><h2>体重</h2></div>
          {(() => {
            const targetYmd = range.startYmd;
            const ymdOf = (iso: string) => new Date(iso).toLocaleDateString("ja-JP", {
              timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
            }).replace(/\//g, "-");
            // 選択日内の最新 → 無ければ全期間で一番新しい (= weights[0])
            const dayMatch = weights.find((w) => ymdOf(w.recordedAt) === targetYmd);
            const fallback = !dayMatch && weights.length > 0 ? weights[0] : null;
            const shown = dayMatch ?? fallback;
            const display = shown ? shown.value.toFixed(1) : "—";
            let meta: string;
            if (dayMatch) {
              meta = "選択日の値";
            } else if (fallback) {
              const fbDate = new Date(fallback.recordedAt);
              const md = `${fbDate.getMonth() + 1}/${fbDate.getDate()}`;
              meta = `${md} の最新値`;
            } else {
              meta = "データなし";
            }
            return (
              <button
                type="button"
                className="health-weight-hero"
                onClick={() => setWeightHistoryOpen(true)}
                title="クリックで履歴を表示"
              >
                <span className="health-weight-hero-value">{display}</span>
                <span className="health-weight-hero-unit">kg</span>
                <span className="health-weight-hero-meta">{meta} ・ 履歴を見る ›</span>
              </button>
            );
          })()}
          <GoalBadge goals={goalItems} metricKey="weight_kg" />
          <WeightSparkChart weights={weights} days={30} />
          {weights.length > 0 && (
            <div className="health-line-foot">
              <span>{Math.min(...weights.slice(0, 30).map((w) => w.value)).toFixed(1)} kg</span>
              <span>直近 30 日 ({Math.min(weights.length, 30)} 件)</span>
              <span>{Math.max(...weights.slice(0, 30).map((w) => w.value)).toFixed(1)} kg</span>
            </div>
          )}
          <div className="health-weight-input">
            <input
              name="health-weight-input"
              type="text"
              inputMode="decimal"
              value={weightInput}
              onChange={(e) => {
                // 数字 + 小数点 (1つまで) だけ通す。IME 経由の全角等も弾く。
                const v = e.target.value.replace(/[^\d.]/g, "");
                const dot = v.indexOf(".");
                const cleaned = dot === -1 ? v : v.slice(0, dot + 1) + v.slice(dot + 1).replace(/\./g, "");
                setWeightInput(cleaned);
              }}
              placeholder="体重を入力"
              className="health-weight-field"
            />
            <span className="health-weight-unit">kg</span>
            <button
              type="button"
              className="health-weight-save"
              onClick={() => void submitWeight()}
              disabled={weightSaving || weightInput.trim().length === 0}
            >{weightSaving ? "..." : "記録"}</button>
          </div>
        </section>

        {/* 体重履歴ポップアップ */}
        {weightHistoryOpen && (
          <div
            className="confirm-popup-backdrop"
            role="presentation"
            onClick={(e) => { if (e.target === e.currentTarget) setWeightHistoryOpen(false); }}
          >
            <div className="confirm-popup confirm-popup-accent health-weight-history-popup" role="dialog" aria-modal="true">
              <h2 className="confirm-popup-title">体重の履歴</h2>
              <div className="health-weight-history-list">
                {weights.length === 0 && <div className="health-empty">体重データ無し</div>}
                {weights.slice(0, 30).map((w, i) => {
                  const dt = new Date(w.recordedAt);
                  const md = `${dt.getMonth() + 1}/${dt.getDate()}`;
                  const prev = weights[i + 1];
                  const delta = prev ? w.value - prev.value : null;
                  return (
                    <div key={w.id} className="health-weight-row">
                      <span className="health-weight-date">{md}</span>
                      <span className="health-weight-value">{w.value.toFixed(1)} kg</span>
                      {delta !== null ? (
                        <span className={`health-weight-delta ${delta > 0 ? "up" : delta < 0 ? "down" : ""}`}>
                          {delta > 0 ? `+${delta.toFixed(1)}` : delta.toFixed(1)}
                        </span>
                      ) : (
                        <span />
                      )}
                      <button
                        type="button"
                        className="health-weight-del"
                        onClick={() => void deleteWeight(w.id)}
                        aria-label="削除"
                        title="削除"
                      >×</button>
                    </div>
                  );
                })}
              </div>
              <div className="confirm-popup-actions">
                <button type="button" className="confirm-cancel-btn" onClick={() => setWeightHistoryOpen(false)}>
                  閉じる
                </button>
              </div>
            </div>
          </div>
        )}

        {/* 運動 */}
        <section className="health-section health-section-wide">
          <div className="health-section-head"><h2>運動 / ジム</h2></div>
          <div className="health-workout-input">
            <div className="health-workout-parts">
              {BODY_PARTS.map((bp) => (
                <button
                  key={bp.key}
                  type="button"
                  className={`health-workout-part${selectedParts.has(bp.key) ? " selected" : ""}`}
                  onClick={() => toggleBodyPart(bp.key)}
                >{bp.label}</button>
              ))}
            </div>
            <button
              type="button"
              className="health-workout-save"
              onClick={() => void submitWorkout()}
              disabled={workoutSaving || selectedParts.size === 0}
            >{workoutSaving ? "..." : "今日のトレを記録"}</button>
          </div>
          <div className="health-workout-list">
            {range.workouts.length === 0 && <div className="health-empty">この日の運動記録はありません。</div>}
            {range.workouts.map((w) => {
              const dt = new Date(w.performedAt);
              const md = `${dt.getMonth() + 1}/${dt.getDate()}`;
              const partsJa = (w.bodyParts ?? []).map((p) => {
                const f = BODY_PARTS.find((b) => b.key === p);
                return f?.label ?? p;
              }).join("・");
              const exShort = (w.exercises ?? []).slice(0, 3).map((e) => {
                let s = e.name ?? "";
                if (typeof e.weight_kg === "number") s += ` ${e.weight_kg}kg`;
                if (typeof e.sets === "number" && typeof e.reps === "number") s += ` ${e.sets}x${e.reps}`;
                if (typeof e.distance_km === "number") s += ` ${e.distance_km}km`;
                return s;
              }).join("、");
              return (
                <div key={w.id} className="health-workout-row">
                  <span className="health-workout-date">{md}</span>
                  <span className="health-workout-parts-text">{partsJa}</span>
                  {exShort && <span className="health-workout-ex">{exShort}</span>}
                  {w.intensity && <span className={`health-workout-intensity ${w.intensity}`}>{w.intensity}</span>}
                  <button
                    type="button"
                    onClick={() => void deleteWorkout(w.id)}
                    className="health-workout-del"
                    aria-label="削除"
                  >×</button>
                </div>
              );
            })}
          </div>
        </section>
      </>
    );
  }

  // ─────────── 週次 / 月次 view ───────────
  function renderRange() {
    if (!range) return null;
    return (
      <>
        {/* HealthKit 活動チャート (日別 bar) */}
        <section className="health-section health-section-wide">
          <div className="health-section-head"><h2>活動 (HealthKit)</h2></div>
          <div className="health-range-charts">
            {SPARK_TYPES.filter((s) => Object.values(range.activityDaily[s.key] ?? {}).some((v) => v > 0)).map((s) => {
              const series = range.ymdList.map((y) => ({ ymd: y, value: range.activityDaily[s.key]?.[y] ?? 0 }));
              const max = Math.max(...series.map((p) => p.value), 1);
              const values = series.filter((p) => p.value > 0).map((p) => p.value);
              const avg = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
              const sum = values.reduce((a, b) => a + b, 0);
              return (
                <div key={s.key} className="health-range-chart">
                  <div className="health-range-chart-head">
                    <span className="health-range-chart-title">{s.label}</span>
                    <span className="health-range-chart-stat">
                      平均 {Math.round(avg).toLocaleString()} / 合計 {Math.round(sum).toLocaleString()} {s.unit}
                    </span>
                  </div>
                  <div className="health-range-bars">
                    {series.map((p) => (
                      <div key={p.ymd} className="health-range-bar-wrap">
                        <div
                          className="health-range-bar"
                          style={{ height: `${Math.max((p.value / max) * 100, 2)}%` }}
                          title={`${p.ymd}: ${p.value} ${s.unit}`}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="health-range-axis">
                    {series.map((p, i) => {
                      const showLabel = mode === "week" || i % Math.ceil(series.length / 10) === 0;
                      return (
                        <span key={p.ymd} className="health-range-axis-tick">
                          {showLabel ? p.ymd.slice(8) : ""}
                        </span>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
        </section>

        {/* 食事 kcal */}
        <section className="health-section health-section-wide">
          <div className="health-section-head">
            <h2>食事 kcal</h2>
            <span className="health-section-date">{range.foods.length} 件</span>
          </div>
          {(() => {
            const series = range.ymdList.map((y) => ({ ymd: y, value: range.foodDaily[y]?.kcal ?? 0 }));
            const max = Math.max(...series.map((p) => p.value), 1);
            const totalKcal = series.reduce((a, b) => a + b.value, 0);
            const daysWith = series.filter((p) => p.value > 0).length;
            const avg = daysWith > 0 ? totalKcal / daysWith : 0;
            return (
              <div className="health-range-chart">
                <div className="health-range-chart-head">
                  <span className="health-range-chart-title">日別 kcal</span>
                  <span className="health-range-chart-stat">平均 {Math.round(avg)} / 合計 {Math.round(totalKcal).toLocaleString()} kcal</span>
                </div>
                <div className="health-range-bars">
                  {series.map((p) => (
                    <div key={p.ymd} className="health-range-bar-wrap">
                      <div
                        className="health-range-bar"
                        style={{ height: `${Math.max((p.value / max) * 100, 2)}%`, background: "linear-gradient(to top, rgb(220, 130, 80), rgb(220, 130, 80, 0.55))" }}
                        title={`${p.ymd}: ${Math.round(p.value)} kcal`}
                      />
                    </div>
                  ))}
                </div>
                <div className="health-range-axis">
                  {series.map((p, i) => {
                    const showLabel = mode === "week" || i % Math.ceil(series.length / 10) === 0;
                    return <span key={p.ymd} className="health-range-axis-tick">{showLabel ? p.ymd.slice(8) : ""}</span>;
                  })}
                </div>
              </div>
            );
          })()}
        </section>

        {/* 体重 line chart */}
        <section className="health-section">
          <div className="health-section-head"><h2>体重</h2></div>
          {(() => {
            const series = range.ymdList
              .map((y) => ({ ymd: y, value: range.scalarDaily.weight_kg?.[y] }))
              .filter((p): p is { ymd: string; value: number } => p.value !== undefined);
            if (series.length === 0) return <div className="health-empty">体重データ無し</div>;
            const min = Math.min(...series.map((p) => p.value));
            const max = Math.max(...series.map((p) => p.value));
            const span = Math.max(max - min, 0.5);
            return (
              <div className="health-line-chart">
                <svg viewBox="0 0 100 40" preserveAspectRatio="none" className="health-line-svg">
                  <polyline
                    fill="none" stroke="var(--accent)" strokeWidth="1.2" strokeLinejoin="round" strokeLinecap="round"
                    points={series.map((p, i) => {
                      const x = series.length === 1 ? 50 : (i / (series.length - 1)) * 100;
                      const y = 38 - ((p.value - min) / span) * 32;
                      return `${x},${y}`;
                    }).join(" ")}
                  />
                  {series.map((p, i) => {
                    const x = series.length === 1 ? 50 : (i / (series.length - 1)) * 100;
                    const y = 38 - ((p.value - min) / span) * 32;
                    return <circle key={p.ymd} cx={x} cy={y} r="1" fill="var(--accent)" />;
                  })}
                </svg>
                <div className="health-line-foot">
                  <span>{min.toFixed(1)} kg</span>
                  <span>{(series[0]).ymd.slice(5)} → {series[series.length - 1].ymd.slice(5)} ({series.length} 件)</span>
                  <span>{max.toFixed(1)} kg</span>
                </div>
              </div>
            );
          })()}
        </section>

        {/* 気分 dot */}
        <section className="health-section">
          <div className="health-section-head"><h2>気分</h2></div>
          {(() => {
            const series = range.ymdList
              .map((y) => ({ ymd: y, value: range.scalarDaily.mood_1to5?.[y] }))
              .filter((p): p is { ymd: string; value: number } => p.value !== undefined);
            if (series.length === 0) return <div className="health-empty">気分データ無し</div>;
            return (
              <div className="health-mood-list">
                {series.map((p) => (
                  <div key={p.ymd} className="health-mood-row">
                    <span className="health-mood-date">{p.ymd.slice(5)}</span>
                    <span className="health-mood-dots">
                      {[1, 2, 3, 4, 5].map((n) => (
                        <span key={n} className={`health-mood-dot${n <= p.value ? " on" : ""}`} />
                      ))}
                    </span>
                    <span className="health-mood-num">{p.value}/5</span>
                  </div>
                ))}
              </div>
            );
          })()}
        </section>

        {/* 運動 history */}
        <section className="health-section health-section-wide">
          <div className="health-section-head">
            <h2>運動 / ジム</h2>
            <span className="health-section-date">{range.workouts.length} 件</span>
          </div>
          {range.workouts.length === 0 ? (
            <div className="health-empty">この期間の運動記録はありません。</div>
          ) : (
            <div className="health-workout-list">
              {range.workouts.map((w) => {
                const dt = new Date(w.performedAt);
                const md = `${dt.getMonth() + 1}/${dt.getDate()}`;
                const partsJa = (w.bodyParts ?? []).map((p) => {
                  const f = BODY_PARTS.find((b) => b.key === p);
                  return f?.label ?? p;
                }).join("・");
                const exShort = (w.exercises ?? []).slice(0, 3).map((e) => {
                  let s = e.name ?? "";
                  if (typeof e.weight_kg === "number") s += ` ${e.weight_kg}kg`;
                  if (typeof e.sets === "number" && typeof e.reps === "number") s += ` ${e.sets}x${e.reps}`;
                  if (typeof e.distance_km === "number") s += ` ${e.distance_km}km`;
                  return s;
                }).join("、");
                return (
                  <div key={w.id} className="health-workout-row">
                    <span className="health-workout-date">{md}</span>
                    <span className="health-workout-parts-text">{partsJa}</span>
                    {exShort && <span className="health-workout-ex">{exShort}</span>}
                    {w.intensity && <span className={`health-workout-intensity ${w.intensity}`}>{w.intensity}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </>
    );
  }
}

/**
 * 目標バッジ — metric_key にマッチする enabled 目標を 1 件表示。
 * weight (one_time) / steps 等 (daily_min) / kcal (daily_max) で見た目を切り替え。
 */
function GoalBadge({ goals, metricKey }: { goals: GoalEval[]; metricKey: string }) {
  const item = goals.find((g) => g.goal.metricKey === metricKey);
  if (!item) return null;
  const { goal, status } = item;
  const label = goal.label;

  if (status.kind === "one_time_by_date") {
    if (status.pace === "achieved") {
      return (
        <div className="health-goal-badge achieved">
          <TrophyIcon /> <span>達成: {label ?? `${goal.targetValue}`}</span>
        </div>
      );
    }
    if (status.current === null) {
      return <div className="health-goal-badge"><TargetIcon /> <span>目標 {goal.targetValue}{label ? ` (${label})` : ""}</span></div>;
    }
    const pct = status.progressPct !== null ? Math.round(status.progressPct) : 0;
    const paceCls = status.pace;
    return (
      <div className={`health-goal-badge one-time pace-${paceCls}`}>
        <div className="health-goal-badge-head">
          <span><TargetIcon /> 目標 {goal.targetValue} {label ? `(${label})` : ""}</span>
          <span>残り {status.daysLeft >= 0 ? `${status.daysLeft} 日` : "期限超過"} / {pct}%</span>
        </div>
        <div className="health-goal-bar">
          <div className="health-goal-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  if (status.kind === "daily_min") {
    if (status.today === null) {
      return <div className="health-goal-badge"><TargetIcon /> <span>目標 {goal.targetValue} / 日 (未測定)</span></div>;
    }
    const pct = status.ratio !== null ? Math.min(100, Math.round(status.ratio * 100)) : 0;
    const mark = status.achieved
      ? (<><CheckIcon /> <span>達成</span></>)
      : (<span>あと {formatNum(status.remaining ?? 0)}</span>);
    return (
      <div className={`health-goal-badge daily-min${status.achieved ? " achieved" : ""}`}>
        <div className="health-goal-badge-head">
          <span><TargetIcon /> {goal.targetValue} / 日</span>
          <span className="health-goal-badge-mark">{mark}</span>
        </div>
        <div className="health-goal-bar">
          <div className="health-goal-bar-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }

  // daily_max
  if (status.today === null) {
    return <div className="health-goal-badge"><GaugeIcon /> <span>上限 {goal.targetValue}{label ? ` (${label})` : ""} (未測定)</span></div>;
  }
  const pct = status.ratio !== null ? Math.min(150, Math.round(status.ratio * 100)) : 0;
  const remainingText = status.exceeded ? `超過 ${formatNum(-(status.remaining ?? 0))}` : `残り ${formatNum(status.remaining ?? 0)}`;
  return (
    <div className={`health-goal-badge daily-max zone-${status.zone}`}>
      <div className="health-goal-badge-head">
        <span><GaugeIcon /> 上限 {goal.targetValue}</span>
        <span>{remainingText} ({Math.min(100, pct)}%)</span>
      </div>
      <div className="health-goal-bar">
        <div className={`health-goal-bar-fill zone-${status.zone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1000) return Math.round(n).toLocaleString();
  return Number(n.toFixed(1)).toString();
}

/**
 * 体重 sparkline (Apple Health 風)
 *  - Catmull-Rom 補間で滑らかな曲線
 *  - 線下にグラデーション fill
 *  - 平均線 (dashed)
 *  - 最新値を accent dot で強調
 */
function WeightSparkChart({ weights, days }: { weights: WeightMetric[]; days: number }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const since = new Date();
  since.setUTCDate(since.getUTCDate() - days);
  const series = weights
    .filter((w) => new Date(w.recordedAt) >= since)
    .slice()
    .reverse(); // 古→新
  const W = 100;
  const H = 40;
  const padX = 2;
  const padY = 4;
  if (series.length === 0) {
    return (
      <div className="health-spark-card">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="health-spark-svg">
          <text x="50" y="22" textAnchor="middle" fontSize="4" fill="rgba(45,34,56,0.35)">データ無し</text>
        </svg>
      </div>
    );
  }
  const min = Math.min(...series.map((p) => p.value));
  const max = Math.max(...series.map((p) => p.value));
  const span = Math.max(max - min, 0.5);
  const avg = series.reduce((a, p) => a + p.value, 0) / series.length;
  const xOf = (i: number) =>
    series.length === 1 ? W / 2 : padX + (i / (series.length - 1)) * (W - padX * 2);
  const yOf = (v: number) => H - padY - ((v - min) / span) * (H - padY * 2);
  const pts = series.map((p, i) => ({ x: xOf(i), y: yOf(p.value), v: p.value }));
  const avgY = yOf(avg);

  // Catmull-Rom → cubic bezier path
  const t = 0.4;
  let d = `M ${pts[0].x} ${pts[0].y}`;
  if (pts.length === 1) {
    d = `M ${pts[0].x} ${pts[0].y}`;
  } else {
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i - 1] ?? pts[i];
      const p1 = pts[i];
      const p2 = pts[i + 1];
      const p3 = pts[i + 2] ?? p2;
      const c1x = p1.x + ((p2.x - p0.x) / 6) * t * 2;
      const c1y = p1.y + ((p2.y - p0.y) / 6) * t * 2;
      const c2x = p2.x - ((p3.x - p1.x) / 6) * t * 2;
      const c2y = p2.y - ((p3.y - p1.y) / 6) * t * 2;
      d += ` C ${c1x.toFixed(2)} ${c1y.toFixed(2)}, ${c2x.toFixed(2)} ${c2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
    }
  }
  const areaD =
    pts.length >= 2
      ? `${d} L ${pts[pts.length - 1].x} ${H} L ${pts[0].x} ${H} Z`
      : "";

  const lastIdx = pts.length - 1;
  return (
    <div className="health-spark-card">
      <div className="health-spark-canvas">
        <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="health-spark-svg">
          <defs>
            <linearGradient id="weight-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
            </linearGradient>
          </defs>
          <line
            x1={padX} y1={avgY} x2={W - padX} y2={avgY}
            stroke="rgba(45,34,56,0.18)" strokeWidth="0.4" strokeDasharray="1 1.5"
          />
          {areaD && <path d={areaD} fill="url(#weight-fill)" />}
          {pts.length >= 2 && (
            <path d={d} fill="none" stroke="var(--accent)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
        {/* 各点に hover 検出 + 表示用 dot。最新点は常時表示、他は hover 時のみ。*/}
        {pts.map((pt, i) => {
          const leftPct = (pt.x / W) * 100;
          const topPct = (pt.y / H) * 100;
          const isLast = i === lastIdx;
          const isHover = hoverIdx === i;
          return (
            <span
              key={i}
              className={`health-spark-point${isLast ? " is-last" : ""}${isHover ? " is-hover" : ""}`}
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx((cur) => (cur === i ? null : cur))}
              aria-label={`${series[i].value.toFixed(1)} kg`}
            />
          );
        })}
        {hoverIdx !== null && (() => {
          const pt = pts[hoverIdx];
          const p = series[hoverIdx];
          const date = new Date(p.recordedAt);
          const md = `${date.getMonth() + 1}/${date.getDate()}`;
          const leftPct = (pt.x / W) * 100;
          const topPct = (pt.y / H) * 100;
          // 左端 / 右端で吹き出しがはみ出さないよう位置を寄せる
          const align = leftPct < 18 ? "start" : leftPct > 82 ? "end" : "center";
          return (
            <div
              className={`health-spark-tooltip align-${align}`}
              style={{ left: `${leftPct}%`, top: `${topPct}%` }}
            >
              <span className="health-spark-tooltip-date">{md}</span>
              <span className="health-spark-tooltip-value">{p.value.toFixed(1)} kg</span>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

/**
 * 食事カロリー 棒グラフ (直近 30 日)
 *  - 各日 1 本のバー、accent カラー
 *  - hover で日付 + kcal の tooltip
 *  - データ無しの日も枠は出して "0" を示す
 */
function KcalBarChart({ series }: { series: Array<{ ymd: string; kcal: number; hasUnknown: boolean; count: number }> }) {
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  if (series.length === 0) return null;
  const max = Math.max(...series.map((p) => p.kcal), 1);
  const sum = series.reduce((a, b) => a + b.kcal, 0);
  const daysWith = series.filter((p) => p.kcal > 0).length;
  const avg = daysWith > 0 ? sum / daysWith : 0;

  return (
    <div className="health-kcal-bar-card">
      <div className="health-kcal-bar-head">
        <span className="health-kcal-bar-title">直近 {series.length} 日 kcal</span>
        <span className="health-kcal-bar-stat">
          平均 {Math.round(avg).toLocaleString()} kcal / 日 ({daysWith} 日記録)
        </span>
      </div>
      <div className="health-kcal-bar-wrap">
        <div className="health-kcal-bar-bars">
          {series.map((p, i) => {
            const heightPct = (p.kcal / max) * 100;
            const isHover = hoverIdx === i;
            return (
              <div
                key={p.ymd}
                className={`health-kcal-bar-col${isHover ? " is-hover" : ""}`}
                onMouseEnter={() => setHoverIdx(i)}
                onMouseLeave={() => setHoverIdx((cur) => (cur === i ? null : cur))}
              >
                <div className="health-kcal-bar-fill" style={{ height: `${heightPct}%` }} />
              </div>
            );
          })}
        </div>
        {hoverIdx !== null && (() => {
          const p = series[hoverIdx];
          const align = hoverIdx < series.length * 0.18 ? "start" : hoverIdx > series.length * 0.82 ? "end" : "center";
          const leftPct = ((hoverIdx + 0.5) / series.length) * 100;
          return (
            <div className={`health-spark-tooltip align-${align}`} style={{ left: `${leftPct}%`, top: 0 }}>
              <span className="health-spark-tooltip-date">{p.ymd.slice(5).replace("-", "/")}</span>
              <span className="health-spark-tooltip-value">
                {p.kcal > 0 ? `${Math.round(p.kcal).toLocaleString()} kcal` : "—"}
              </span>
            </div>
          );
        })()}
      </div>
    </div>
  );
}

function FoodLogCard({
  log, editing, onEdit, onCancelEdit, onSaved, onDelete,
}: {
  log: FoodLogEntry;
  editing: boolean;
  onEdit: () => void;
  onCancelEdit: () => void;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const [items, setItems] = useState<FoodItem[]>(log.items);
  const [saving, setSaving] = useState(false);
  // log.items 変化時に編集 item を同期 (anti-pattern #4 / key prop follow-up)。
  // eslint-disable-next-line react-hooks/set-state-in-effect -- prop sync
  useEffect(() => { setItems(log.items); }, [log.items]);

  const time = new Date(log.eatenAt).toLocaleTimeString("ja-JP", { hour: "2-digit", minute: "2-digit", hour12: false });
  const updateItem = (i: number, patch: Partial<FoodItem>) => {
    setItems((cur) => cur.map((it, idx) => idx === i ? { ...it, ...patch } : it));
  };
  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/food/${log.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
      });
      if (res.ok) onSaved();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="health-food-card">
      <div className="health-food-head">
        <span className="health-food-time">{time}</span>
        <span className="health-food-kcal">
          {log.totalKcal !== null ? `${Math.round(log.totalKcal)} kcal` : "—"}
        </span>
        <div className="health-food-actions">
          {!editing && <button type="button" onClick={onEdit} className="health-food-btn">編集</button>}
          {!editing && <button type="button" onClick={onDelete} className="health-food-btn danger">削除</button>}
        </div>
      </div>
      <ul className="health-food-items">
        {items.map((it, i) => (
          <li key={i} className={`health-food-item${editing ? " editing" : ""}`}>
            {editing ? (
              <div className="health-food-item-edit-wrap">
                <div className="health-food-item-edit-row">
                  <input name="health-food-item-name" className="health-food-item-name" value={it.name} onChange={(e) => updateItem(i, { name: e.target.value })} />
                  <input
                    name="health-food-item-qty"
                    type="number" step={0.1} className="health-food-item-qty"
                    value={it.quantity ?? 1}
                    onChange={(e) => updateItem(i, { quantity: parseFloat(e.target.value) || 1 })}
                  />
                  <input
                    name="health-food-item-unit"
                    type="text" className="health-food-item-unit-input"
                    value={it.unit ?? ""}
                    onChange={(e) => updateItem(i, { unit: e.target.value })}
                    placeholder="単位"
                  />
                  <input
                    name="health-food-item-kcal"
                    type="number" className="health-food-item-kcal"
                    value={it.kcal ?? ""}
                    onChange={(e) => {
                      const v = e.target.value === "" ? null : parseFloat(e.target.value);
                      updateItem(i, { kcal: Number.isFinite(v) ? v : null });
                    }}
                    placeholder="kcal"
                  />
                  <span>kcal</span>
                </div>
                <div className="health-food-item-edit-pfc">
                  <label className="health-food-pfc-field">
                    <span>P</span>
                    <input
                      name="health-food-item-protein"
                      type="number" step={0.1}
                      value={it.protein ?? ""}
                      onChange={(e) => {
                        const v = e.target.value === "" ? null : parseFloat(e.target.value);
                        updateItem(i, { protein: Number.isFinite(v) ? v : null });
                      }}
                      placeholder="タンパク質"
                    />
                    <span>g</span>
                  </label>
                  <label className="health-food-pfc-field">
                    <span>C</span>
                    <input
                      name="health-food-item-carbs"
                      type="number" step={0.1}
                      value={it.carbs ?? ""}
                      onChange={(e) => {
                        const v = e.target.value === "" ? null : parseFloat(e.target.value);
                        updateItem(i, { carbs: Number.isFinite(v) ? v : null });
                      }}
                      placeholder="炭水化物"
                    />
                    <span>g</span>
                  </label>
                  <label className="health-food-pfc-field">
                    <span>F</span>
                    <input
                      name="health-food-item-fat"
                      type="number" step={0.1}
                      value={it.fat ?? ""}
                      onChange={(e) => {
                        const v = e.target.value === "" ? null : parseFloat(e.target.value);
                        updateItem(i, { fat: Number.isFinite(v) ? v : null });
                      }}
                      placeholder="脂質"
                    />
                    <span>g</span>
                  </label>
                  <label className="health-food-pfc-field">
                    <span>食物繊維</span>
                    <input
                      name="health-food-item-fiber"
                      type="number" step={0.1}
                      value={it.fiber ?? ""}
                      onChange={(e) => {
                        const v = e.target.value === "" ? null : parseFloat(e.target.value);
                        updateItem(i, { fiber: Number.isFinite(v) ? v : null });
                      }}
                      placeholder="食物繊維"
                    />
                    <span>g</span>
                  </label>
                  <label className="health-food-pfc-field">
                    <span>食塩</span>
                    <input
                      name="health-food-item-salt"
                      type="number" step={0.1}
                      value={it.salt ?? ""}
                      onChange={(e) => {
                        const v = e.target.value === "" ? null : parseFloat(e.target.value);
                        updateItem(i, { salt: Number.isFinite(v) ? v : null });
                      }}
                      placeholder="食塩"
                    />
                    <span>g</span>
                  </label>
                </div>
              </div>
            ) : (
              <>
                <span className="health-food-item-name">{it.name}</span>
                <span className="health-food-item-qty">
                  {it.quantity ?? 1} {it.unit ?? ""}
                </span>
                <span className="health-food-item-kcal">
                  {it.kcal !== null && it.kcal !== undefined ? `${Math.round(it.kcal)} kcal` : "—"}
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
      {editing && (
        <div className="health-food-edit-foot">
          <button type="button" className="health-food-btn" onClick={onCancelEdit}>キャンセル</button>
          <button type="button" className="health-food-btn primary" onClick={() => void save()} disabled={saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      )}
    </div>
  );
}
