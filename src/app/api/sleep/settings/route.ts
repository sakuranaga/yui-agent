/**
 * GET   /api/sleep/settings        singleton 設定を返す
 * PATCH /api/sleep/settings        部分更新 (numeric フィールドのみ)
 *
 * 設計: docs/sleep-support.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepSettings } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

type NumericKey =
  | "ttsDurationScale"
  | "ttsCfgScaleSpeaker"
  | "intervalMinSec"
  | "intervalMaxSec"
  | "defaultTimerMin"
  | "difficultyMax"
  | "affirmationProbability"
  | "bgmVolume"
  | "ttsVolume"
  | "bgmDuckDb";

async function loadOrInit() {
  const rows = await db.select().from(sleepSettings).where(eq(sleepSettings.id, 1));
  if (rows.length === 0) {
    await db.insert(sleepSettings).values({ id: 1 }).onConflictDoNothing();
    const r2 = await db.select().from(sleepSettings).where(eq(sleepSettings.id, 1));
    return r2[0];
  }
  return rows[0];
}

function toResponse(s: Awaited<ReturnType<typeof loadOrInit>>) {
  return {
    tts_duration_scale: s.ttsDurationScale,
    tts_cfg_scale_speaker: s.ttsCfgScaleSpeaker,
    interval_min_sec: s.intervalMinSec,
    interval_max_sec: s.intervalMaxSec,
    default_timer_min: s.defaultTimerMin,
    difficulty_max: s.difficultyMax,
    affirmation_probability: s.affirmationProbability,
    bgm_volume: s.bgmVolume,
    tts_volume: s.ttsVolume,
    bgm_duck_db: s.bgmDuckDb,
    updated_at: s.updatedAt.toISOString(),
  };
}

export async function GET() {
  const s = await loadOrInit();
  return NextResponse.json({ settings: toResponse(s) });
}

const SNAKE_TO_CAMEL: Record<string, NumericKey> = {
  tts_duration_scale: "ttsDurationScale",
  tts_cfg_scale_speaker: "ttsCfgScaleSpeaker",
  interval_min_sec: "intervalMinSec",
  interval_max_sec: "intervalMaxSec",
  default_timer_min: "defaultTimerMin",
  difficulty_max: "difficultyMax",
  affirmation_probability: "affirmationProbability",
  bgm_volume: "bgmVolume",
  tts_volume: "ttsVolume",
  bgm_duck_db: "bgmDuckDb",
};

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }
  const patch: Partial<Record<NumericKey, number>> = {};
  for (const [k, raw] of Object.entries(body)) {
    const camel = SNAKE_TO_CAMEL[k];
    if (!camel) continue;
    const n = typeof raw === "number" ? raw : parseFloat(String(raw));
    if (!Number.isFinite(n)) continue;
    patch[camel] = n;
  }
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no updatable fields" }, { status: 400 });
  }
  await loadOrInit();
  await db
    .update(sleepSettings)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(sleepSettings.id, 1));
  const s = await loadOrInit();
  return NextResponse.json({ settings: toResponse(s) });
}
