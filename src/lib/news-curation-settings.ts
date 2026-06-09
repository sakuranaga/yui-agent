/**
 * ニュースキュレーション設定 (singleton) の DB アクセス層 + 30s キャッシュ。
 *
 * 設計: docs/news-curation.md §5, §8.2
 */
import { db } from "@/db/client";
import { newsCurationSettings, type NewsCurationSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

export type CurationSettings = {
  interestProfile: string;
  scoreThreshold: number;
  minSpeakIntervalHours: number;
  lastSpokenAt: Date | null;
};

const DEFAULTS: CurationSettings = {
  interestProfile: "",
  scoreThreshold: 0.6,
  minSpeakIntervalHours: 1,
  lastSpokenAt: null,
};

let cached: CurationSettings | null = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30_000;

function rowToSettings(r: NewsCurationSettings): CurationSettings {
  return {
    interestProfile: r.interestProfile,
    scoreThreshold: r.scoreThreshold,
    minSpeakIntervalHours: r.minSpeakIntervalHours,
    lastSpokenAt: r.lastSpokenAt,
  };
}

export async function getCurationSettings(): Promise<CurationSettings> {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  try {
    const [row] = await db
      .select()
      .from(newsCurationSettings)
      .where(eq(newsCurationSettings.id, 1))
      .limit(1);
    const next = row ? rowToSettings(row) : DEFAULTS;
    cached = next;
    cachedAt = Date.now();
    return next;
  } catch (e) {
    console.warn("[news-curation-settings] load failed, using defaults:", e);
    return DEFAULTS;
  }
}

export async function updateCurationSettings(
  patch: Partial<Omit<CurationSettings, "lastSpokenAt">>
): Promise<void> {
  const current = await getCurationSettings();
  const next: CurationSettings = { ...current, ...patch };
  await db
    .insert(newsCurationSettings)
    .values({
      id: 1,
      interestProfile: next.interestProfile,
      scoreThreshold: next.scoreThreshold,
      minSpeakIntervalHours: next.minSpeakIntervalHours,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: newsCurationSettings.id,
      set: {
        interestProfile: next.interestProfile,
        scoreThreshold: next.scoreThreshold,
        minSpeakIntervalHours: next.minSpeakIntervalHours,
        updatedAt: new Date(),
      },
    });
  invalidateCache();
}

/** speak 発火直後に呼ぶ。throttle 判定の起点。 */
export async function markSpoken(at: Date = new Date()): Promise<void> {
  await db
    .insert(newsCurationSettings)
    .values({ id: 1, lastSpokenAt: at, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: newsCurationSettings.id,
      set: { lastSpokenAt: at, updatedAt: new Date() },
    });
  invalidateCache();
}

export function invalidateCache(): void {
  cached = null;
  cachedAt = 0;
}
