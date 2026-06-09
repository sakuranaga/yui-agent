/**
 * 秘書 Lv の XP 管理レイヤ。
 *
 * - addXp({event_type, xp, refTable, refId}): 1 行 insert (ON CONFLICT DO NOTHING)
 * - getTotalXp(): xp_events の SUM
 * - levelFromTotalXp(total): Lv1〜LV_MAX に換算 + 現 Lv での進捗
 *
 * レベル曲線: Lv N → Lv N+1 に必要な XP = floor(LV_CONST * N^LV_EXP)
 *   Lv1→2: 50, Lv5→6: 415, Lv10→11: 1995, Lv20→21: 7892, Lv30 上限
 */
import { sql } from "drizzle-orm";
import { db } from "@/db/client";
import { xpEvents } from "@/db/schema";
import { broadcastStatsUpdate } from "@/lib/jobs/events";

export type XpEventType =
  | "chat_turn"
  | "heart_received"
  | "todo_completed"
  | "diary_generated"
  | "specialist_run"
  | "morning_brief"
  | "music_played";

/** 各イベントのデフォルト XP 値。callsite で override 可。 */
export const DEFAULT_XP_BY_TYPE: Record<XpEventType, number> = {
  chat_turn: 1,
  heart_received: 5,
  todo_completed: 3,
  diary_generated: 2,
  specialist_run: 3,
  morning_brief: 2,
  music_played: 0.5,
};

export const LV_MAX = 30;
const LV_CONST = 50;
const LV_EXP = 1.4;

/** Lv N→N+1 に必要な単発 XP (累計ではない)。N=1〜LV_MAX-1 で意味あり。 */
function xpNeededForNext(level: number): number {
  return Math.floor(LV_CONST * Math.pow(level, LV_EXP));
}

export type LevelInfo = {
  level: number;
  /** 現 Lv に到達してから稼いだ XP (バーの分子) */
  xpInCurrentLevel: number;
  /** Lv→次 Lv の到達に必要な XP (バーの分母)、上限到達時は 0 */
  xpForNextLevel: number;
  /** 累計 XP (デバッグ / UI 表示用) */
  totalXp: number;
};

export function levelFromTotalXp(totalXp: number): LevelInfo {
  let lv = 1;
  let consumed = 0;
  while (lv < LV_MAX) {
    const need = xpNeededForNext(lv);
    if (consumed + need > totalXp) break;
    consumed += need;
    lv++;
  }
  const xpInCurrentLevel = Math.max(0, totalXp - consumed);
  const xpForNextLevel = lv >= LV_MAX ? 0 : xpNeededForNext(lv);
  return { level: lv, xpInCurrentLevel, xpForNextLevel, totalXp };
}

export async function getTotalXp(): Promise<number> {
  const rows = await db
    .select({ s: sql<number>`coalesce(sum(${xpEvents.xp}), 0)::real` })
    .from(xpEvents);
  return Number(rows[0]?.s ?? 0);
}

/**
 * XP 1 件を加算 (idempotent: 同じ event_type + ref_table + ref_id があれば skip)。
 * insert が成功したときだけ SSE で stats_update を broadcast (Lv が桁を跨いだら
 * levelUp を含める)。fire-and-forget で呼んで OK。
 */
export async function addXp(opts: {
  eventType: XpEventType;
  xp?: number;
  refTable?: string;
  refId?: number;
  createdAt?: Date;
}): Promise<void> {
  const xp = opts.xp ?? DEFAULT_XP_BY_TYPE[opts.eventType];
  if (!xp || xp <= 0) return;
  const row = {
    eventType: opts.eventType,
    xp,
    refTable: opts.refTable ?? null,
    refId: opts.refId ?? null,
    ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
  };
  try {
    // Lv 判定のため、insert 前の累計 XP を読んでおく (insert 成功時のみ使う)
    const prevTotal = await getTotalXp();
    const inserted = await db
      .insert(xpEvents)
      .values(row)
      .onConflictDoNothing({
        target: [xpEvents.eventType, xpEvents.refTable, xpEvents.refId],
      })
      .returning({ id: xpEvents.id });
    if (inserted.length === 0) return; // 重複で skip された
    const lvUp = detectLevelUp(prevTotal, prevTotal + xp);
    broadcastStatsUpdate(lvUp ?? undefined);
  } catch (e) {
    // ref 重複や DB 一時障害は無視 (XP は eventual consistency で十分)
    console.warn("[xp] addXp failed:", e);
  }
}

/** 「Lv 桁が変わったか」を判定して levelUp イベントが必要か返す。 */
export function detectLevelUp(prevTotal: number, nextTotal: number):
  | { from: number; to: number }
  | null {
  const prev = levelFromTotalXp(prevTotal).level;
  const next = levelFromTotalXp(nextTotal).level;
  if (next > prev) return { from: prev, to: next };
  return null;
}
