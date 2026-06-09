/**
 * サイレント時間帯設定。
 *
 * 旧 v1 の `activity.ts:isNightJST()` (= 22-7 JST ハードコード) を置換し、
 * UI から開始時刻 / 終了時刻 / ON/OFF を制御可能にする。
 *
 * 設計: docs/notification-system.md §8.2
 */
import { db } from "@/db/client";
import { quietHoursSettings, type QuietHoursSetting } from "@/db/schema";
import { eq } from "drizzle-orm";
import { cacheGet, cacheSet, cacheDel } from "@/lib/cache";

export type QuietHours = {
  enabled: boolean;
  startHour: number; // 0-23
  endHour: number;   // 0-23
};

const CACHE_KEY = "quiet-hours:singleton";
const CACHE_TTL_SEC = 30;

const DEFAULT: QuietHours = {
  enabled: false,
  startHour: 22,
  endHour: 7,
};

function rowToValue(r: QuietHoursSetting): QuietHours {
  return {
    enabled: r.enabled,
    startHour: r.startHour,
    endHour: r.endHour,
  };
}

/**
 * 現在のサイレント時間設定を取得する。
 * - Valkey 30s cache
 * - DB に行が無い場合 (= migration 未適用 / 行欠損) は default を返す
 */
export async function getQuietHours(): Promise<QuietHours> {
  const hit = await cacheGet<QuietHours>(CACHE_KEY);
  if (hit) return hit;

  try {
    const [row] = await db
      .select()
      .from(quietHoursSettings)
      .where(eq(quietHoursSettings.id, 1))
      .limit(1);
    const value = row ? rowToValue(row) : DEFAULT;
    await cacheSet(CACHE_KEY, value, CACHE_TTL_SEC);
    return value;
  } catch (e) {
    console.warn("[quiet-hours] load failed, using default:", e);
    return DEFAULT;
  }
}

/**
 * 設定を更新する (= UPSERT)。cache invalidate も併せて行う。
 * 不正値 (= hour が 0-23 外) は throw。
 */
export async function setQuietHours(
  patch: Partial<QuietHours>
): Promise<QuietHours> {
  if (patch.startHour !== undefined) {
    if (
      !Number.isInteger(patch.startHour) ||
      patch.startHour < 0 ||
      patch.startHour > 23
    ) {
      throw new Error(`startHour must be integer 0-23, got: ${patch.startHour}`);
    }
  }
  if (patch.endHour !== undefined) {
    if (
      !Number.isInteger(patch.endHour) ||
      patch.endHour < 0 ||
      patch.endHour > 23
    ) {
      throw new Error(`endHour must be integer 0-23, got: ${patch.endHour}`);
    }
  }
  const current = await getQuietHours();
  const next: QuietHours = { ...current, ...patch };

  await db
    .insert(quietHoursSettings)
    .values({
      id: 1,
      enabled: next.enabled,
      startHour: next.startHour,
      endHour: next.endHour,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: quietHoursSettings.id,
      set: {
        enabled: next.enabled,
        startHour: next.startHour,
        endHour: next.endHour,
        updatedAt: new Date(),
      },
    });
  await cacheDel(CACHE_KEY);
  return next;
}

/**
 * 現在 (= now or 指定時刻) がサイレント時間帯内かどうかを判定する。
 * - enabled=false なら常に false
 * - JST の hour を基準に判定 (= サーバ TZ 非依存)
 * - 翌日跨ぎ対応: start_hour <= end_hour は [start, end) の通常区間、
 *   start_hour > end_hour は [start, 24) ∪ [0, end) の跨ぎ区間
 * - start_hour == end_hour は「サイレント無し」扱い (= false 固定)
 */
export async function isInQuietHours(now: Date = new Date()): Promise<boolean> {
  const settings = await getQuietHours();
  if (!settings.enabled) return false;
  const hour = jstHour(now);
  return inRange(hour, settings.startHour, settings.endHour);
}

function jstHour(d: Date): number {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
  });
  const h = fmt.formatToParts(d).find((p) => p.type === "hour")?.value ?? "0";
  return parseInt(h, 10);
}

function inRange(hour: number, start: number, end: number): boolean {
  if (start === end) return false; // 「サイレント無し」扱い
  if (start < end) return hour >= start && hour < end; // 通常: [start, end)
  return hour >= start || hour < end; // 跨ぎ: [start, 24) ∪ [0, end)
}
