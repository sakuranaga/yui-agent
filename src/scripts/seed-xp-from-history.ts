/**
 * 過去データから XP を 1 回限りで埋めるスクリプト。
 *
 * 実行: docker compose exec web npx tsx src/scripts/seed-xp-from-history.ts
 *
 * 仕様:
 *   - raw_messages.role='user' → chat_turn +1
 *   - like_events                → heart_received +5
 *   - todos.completed_at IS NOT NULL → todo_completed +3
 *   - diary_entries              → diary_generated +2
 *   - tasks.status='succeeded'   → specialist_run +3
 *   - music_track_history        → music_played +0.5
 *
 * 各 INSERT は (event_type, ref_table, ref_id) 部分 unique で重複ガード。
 * 2 回目以降の実行も idempotent (新規発生分のみ追加される運用にもなる)。
 */
import { db } from "@/db/client";
import {
  diaryEntries,
  likeEvents,
  musicTrackHistory,
  rawMessages,
  tasks,
  todos,
  xpEvents,
  type NewXpEventRow,
} from "@/db/schema";
import { eq, isNotNull, sql } from "drizzle-orm";
import { DEFAULT_XP_BY_TYPE } from "@/lib/xp";

async function bulkInsert(rows: NewXpEventRow[], label: string) {
  if (rows.length === 0) {
    console.log(`[seed-xp] ${label}: 0 件`);
    return 0;
  }
  // 部分 unique を完全には Drizzle が捕まえられないので、明示的に column 指定で onConflict
  const batch = 500;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += batch) {
    const slice = rows.slice(i, i + batch);
    await db
      .insert(xpEvents)
      .values(slice)
      .onConflictDoNothing({
        target: [xpEvents.eventType, xpEvents.refTable, xpEvents.refId],
      });
    inserted += slice.length;
  }
  console.log(`[seed-xp] ${label}: ${inserted} 件 (重複は ON CONFLICT で吸収)`);
  return inserted;
}

async function main() {
  // 1. chat_turn (user 発話)
  const userRows = await db
    .select({ id: rawMessages.id, createdAt: rawMessages.createdAt })
    .from(rawMessages)
    .where(eq(rawMessages.role, "user"));
  await bulkInsert(
    userRows.map((r) => ({
      eventType: "chat_turn" as const,
      xp: DEFAULT_XP_BY_TYPE.chat_turn,
      refTable: "raw_messages",
      refId: r.id,
      createdAt: r.createdAt,
    })),
    "chat_turn"
  );

  // 2. heart_received
  const heartRows = await db
    .select({ id: likeEvents.id, createdAt: likeEvents.createdAt })
    .from(likeEvents);
  await bulkInsert(
    heartRows.map((r) => ({
      eventType: "heart_received" as const,
      xp: DEFAULT_XP_BY_TYPE.heart_received,
      refTable: "like_events",
      refId: r.id,
      createdAt: r.createdAt,
    })),
    "heart_received"
  );

  // 3. todo_completed
  const todoRows = await db
    .select({ id: todos.id, completedAt: todos.completedAt })
    .from(todos)
    .where(isNotNull(todos.completedAt));
  await bulkInsert(
    todoRows.map((r) => ({
      eventType: "todo_completed" as const,
      xp: DEFAULT_XP_BY_TYPE.todo_completed,
      refTable: "todos",
      refId: r.id,
      createdAt: r.completedAt ?? undefined,
    })),
    "todo_completed"
  );

  // 4. diary_generated
  const diaryRows = await db
    .select({ id: diaryEntries.id, generatedAt: diaryEntries.generatedAt })
    .from(diaryEntries);
  await bulkInsert(
    diaryRows.map((r) => ({
      eventType: "diary_generated" as const,
      xp: DEFAULT_XP_BY_TYPE.diary_generated,
      refTable: "diary_entries",
      refId: r.id,
      createdAt: r.generatedAt,
    })),
    "diary_generated"
  );

  // 5. specialist_run (tasks.status='succeeded')
  const taskRows = await db
    .select({ id: tasks.id, completedAt: tasks.completedAt })
    .from(tasks)
    .where(eq(tasks.status, "succeeded"));
  await bulkInsert(
    taskRows.map((r) => ({
      eventType: "specialist_run" as const,
      xp: DEFAULT_XP_BY_TYPE.specialist_run,
      refTable: "tasks",
      refId: r.id,
      createdAt: r.completedAt ?? undefined,
    })),
    "specialist_run"
  );

  // 6. music_played
  const musicRows = await db
    .select({ id: musicTrackHistory.id, playedAt: musicTrackHistory.playedAt })
    .from(musicTrackHistory);
  await bulkInsert(
    musicRows.map((r) => ({
      eventType: "music_played" as const,
      xp: DEFAULT_XP_BY_TYPE.music_played,
      refTable: "music_track_history",
      refId: r.id,
      createdAt: r.playedAt,
    })),
    "music_played"
  );

  // 集計レポート
  const totals = await db
    .select({
      sum: sql<number>`coalesce(sum(${xpEvents.xp}), 0)::real`,
      count: sql<number>`count(*)::int`,
    })
    .from(xpEvents);
  console.log(
    `[seed-xp] 完了: 合計 ${totals[0].count} 行 / 合計 XP ${totals[0].sum.toFixed(1)}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[seed-xp] failed:", e);
    process.exit(1);
  });
