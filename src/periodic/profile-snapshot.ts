/**
 * ご主人様プロファイル スナップショット 自動生成 cron。
 *
 * 設計: docs/user-profile-snapshot.md
 *
 * - 1 時間 interval
 * - JST 22 時以降に、今日の snapshot がまだ無ければ生成
 * - 失敗時は次の 1 時間でリトライ
 * - fire しない (Yui voice 通知は出さない、内部処理だけ)
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import { db } from "@/db/client";
import { userProfileSnapshots } from "@/db/schema";
import { and, gte, lt } from "drizzle-orm";
import { generateProfileSnapshot } from "@/lib/user-profile";

const TARGET_HOUR_JST = parseInt(process.env.PROFILE_SNAPSHOT_HOUR_JST ?? "22", 10);

function jstHour(d: Date = new Date()): number {
  const h = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    hour12: false,
  })
    .formatToParts(d)
    .find((p) => p.type === "hour")?.value;
  return parseInt(h ?? "0", 10);
}

function jstDayBounds(d: Date = new Date()): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const ymd = `${g("year")}-${g("month")}-${g("day")}`;
  const start = new Date(`${ymd}T00:00:00+09:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

const profileSnapshot: PeriodicModule = {
  id: "profile-snapshot",
  enabled: true,
  schedule: { kind: "interval", everyMs: 60 * 60_000 },
  run: async (_ctx: PeriodicContext): Promise<PeriodicResult> => {
    const now = new Date();
    const hour = jstHour(now);
    if (hour < TARGET_HOUR_JST) {
      return { skip: true, reason: `before ${TARGET_HOUR_JST}h JST (now ${hour}h)` };
    }
    const today = jstDayBounds(now);
    const existing = await db
      .select({ id: userProfileSnapshots.id })
      .from(userProfileSnapshots)
      .where(
        and(
          gte(userProfileSnapshots.snapshotDate, today.start),
          lt(userProfileSnapshots.snapshotDate, today.end)
        )
      )
      .limit(1);
    if (existing.length > 0) {
      return { skip: true, reason: "already exists for today" };
    }
    try {
      const snap = await generateProfileSnapshot(now, "cron");
      console.log(`[profile-snapshot] generated for ${snap.snapshotDate} (id=${snap.id})`);
      return { skip: true, reason: `generated ${snap.snapshotDate}` };
    } catch (e) {
      console.warn("[profile-snapshot] generation failed:", e);
      return { skip: true, reason: `error: ${e instanceof Error ? e.message : String(e)}` };
    }
  },
};

export default profileSnapshot;
