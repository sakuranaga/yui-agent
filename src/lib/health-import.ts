/**
 * HealthKit / Garmin / Fitbit など外部ヘルスデータの取り込みロジック。
 *
 * 設計: docs/health-tracking.md §11 Phase 5
 *
 * 受け取る metric_type:
 *   ── 日次集計 (= 同日上書き / UPSERT)
 *     steps_daily          歩数
 *     active_kcal_daily    活動 (動いて燃やした) kcal
 *     basal_kcal_daily     基礎代謝 kcal
 *     stand_hours_daily    スタンド時間 (時間)
 *     exercise_min_daily   運動分数
 *     distance_km_daily    移動距離 km
 *     sleep_hours_daily    睡眠時間 (HealthKit)
 *   ── point-in-time (= 都度 INSERT)
 *     heart_rate           心拍 (任意時刻)
 *     resting_hr           安静時心拍 (1 日複数あり得るが基本 1 件/日)
 *     spo2                 血中酸素
 *     weight_kg            体重 (HealthKit 連動 → 既存と同じ系列)
 *     body_fat_pct         体脂肪 (同上)
 */
import { db } from "@/db/client";
import { bodyMetrics } from "@/db/schema";
import { and, eq, gte, lt } from "drizzle-orm";

export const DAILY_METRICS = new Set([
  "steps_daily",
  "active_kcal_daily",
  "basal_kcal_daily",
  "stand_hours_daily",
  "exercise_min_daily",
  "distance_km_daily",
  "sleep_hours_daily",
]);

export const POINT_METRICS = new Set([
  "heart_rate",
  "resting_hr",
  "spo2",
  "weight_kg",
  "body_fat_pct",
]);

export type ImportMetric = {
  /** メトリクス種別 */
  type: string;
  /** 数値 */
  value: number;
  /**
   * 日次メトリクスの場合: 対象日 YYYY-MM-DD (JST 解釈)。未指定なら recorded_at の日。
   * point-in-time の場合: 無視 (recorded_at を使う)
   */
  date?: string;
  /** point-in-time: 計測時刻 ISO。未指定なら now */
  recorded_at?: string;
  /** 出典 (apple_health / manual / garmin 等) */
  source?: string;
  /** 任意メモ */
  notes?: string;
};

export type ImportResult = {
  accepted: number;
  rejected: number;
  upserted: number;
  inserted: number;
  errors: Array<{ index: number; reason: string }>;
};

/** JST の日付 ymd → その日の 23:59:59 JST の Date (日次代表値の recorded_at) */
function jstDayEnd(ymd: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  return new Date(`${ymd}T23:59:59+09:00`);
}

function jstYmdOf(d: Date): string {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function jstDayBounds(ymd: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const start = new Date(`${ymd}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

function isValidValue(t: string, v: number): boolean {
  if (!Number.isFinite(v) || v < 0) return false;
  if (t === "steps_daily" && v > 200_000) return false;
  if (t === "active_kcal_daily" && v > 10_000) return false;
  if (t === "basal_kcal_daily" && v > 5_000) return false;
  if (t === "heart_rate" && (v < 20 || v > 250)) return false;
  if (t === "resting_hr" && (v < 30 || v > 150)) return false;
  if (t === "spo2" && (v < 50 || v > 100)) return false;
  if (t === "weight_kg" && (v < 20 || v > 300)) return false;
  if (t === "body_fat_pct" && (v < 3 || v > 60)) return false;
  if (t === "sleep_hours_daily" && v > 24) return false;
  if (t === "exercise_min_daily" && v > 24 * 60) return false;
  if (t === "stand_hours_daily" && v > 24) return false;
  if (t === "distance_km_daily" && v > 500) return false;
  return true;
}

export async function importHealthMetrics(
  metrics: ImportMetric[],
  defaultSource = "apple_health"
): Promise<ImportResult> {
  const res: ImportResult = {
    accepted: 0, rejected: 0, upserted: 0, inserted: 0, errors: [],
  };
  for (let i = 0; i < metrics.length; i++) {
    const m = metrics[i];
    try {
      if (typeof m.type !== "string" || (!DAILY_METRICS.has(m.type) && !POINT_METRICS.has(m.type))) {
        res.rejected++;
        res.errors.push({ index: i, reason: `unknown metric_type: ${m.type}` });
        continue;
      }
      if (!isValidValue(m.type, m.value)) {
        res.rejected++;
        res.errors.push({ index: i, reason: `invalid value ${m.value} for ${m.type}` });
        continue;
      }
      const source = m.source ?? defaultSource;

      if (DAILY_METRICS.has(m.type)) {
        // 日次: その日の既存行を見つけて UPDATE、無ければ INSERT
        const ymd = m.date ?? (m.recorded_at ? jstYmdOf(new Date(m.recorded_at)) : jstYmdOf(new Date()));
        const bounds = jstDayBounds(ymd);
        const recordedAt = jstDayEnd(ymd);
        if (!bounds || !recordedAt) {
          res.rejected++;
          res.errors.push({ index: i, reason: `invalid date: ${ymd}` });
          continue;
        }
        const existing = await db
          .select({ id: bodyMetrics.id })
          .from(bodyMetrics)
          .where(
            and(
              eq(bodyMetrics.metricType, m.type),
              gte(bodyMetrics.recordedAt, bounds.start),
              lt(bodyMetrics.recordedAt, bounds.end)
            )
          )
          .limit(1);
        if (existing.length > 0) {
          await db
            .update(bodyMetrics)
            .set({ value: m.value, recordedAt, source, notes: m.notes ?? null })
            .where(eq(bodyMetrics.id, existing[0].id));
          res.upserted++;
        } else {
          await db.insert(bodyMetrics).values({
            metricType: m.type,
            value: m.value,
            recordedAt,
            source,
            notes: m.notes ?? null,
            sourceMessageId: null,
          });
          res.inserted++;
        }
      } else {
        // point-in-time: append-only
        const recordedAt = m.recorded_at ? new Date(m.recorded_at) : new Date();
        if (Number.isNaN(recordedAt.getTime())) {
          res.rejected++;
          res.errors.push({ index: i, reason: `invalid recorded_at: ${m.recorded_at}` });
          continue;
        }
        await db.insert(bodyMetrics).values({
          metricType: m.type,
          value: m.value,
          recordedAt,
          source,
          notes: m.notes ?? null,
          sourceMessageId: null,
        });
        res.inserted++;
      }
      res.accepted++;
    } catch (e) {
      res.rejected++;
      res.errors.push({ index: i, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return res;
}
