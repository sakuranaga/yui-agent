/**
 * Reminders: 予定 / 習慣の事前通知。
 *
 * - DB (reminders) に永続化、dispatcher (periodic) が 1 分間隔で発火判定
 * - schedule.kind="once": 発火後 enabled=false (= 一回限り)
 * - schedule.kind="weekly": 該当曜日の base_time に毎週発火
 * - 発火時刻 = base - lead_minutes 分
 *
 * 設計: docs/reminders-system.md
 */
import { db } from "@/db/client";
import {
  reminders,
  type Reminder,
  type ReminderSchedule,
  type NewReminder,
} from "@/db/schema";
import { and, eq, isNull, or, lte, asc, sql } from "drizzle-orm";

const TZ = "Asia/Tokyo";

// ───── CRUD ─────

export type CreateReminderInput = {
  sessionId: string;
  kind: Reminder["kind"];
  title: string;
  extraPrompt?: string | null;
  schedule: ReminderSchedule;
  refTable?: string | null;
  refId?: number | null;
};

export async function createReminder(input: CreateReminderInput): Promise<Reminder> {
  const nextDue = computeNextDueAt(input.schedule, null);
  const newRow: NewReminder = {
    sessionId: input.sessionId,
    kind: input.kind,
    title: input.title,
    extraPrompt: input.extraPrompt ?? null,
    schedule: input.schedule,
    refTable: input.refTable ?? null,
    refId: input.refId ?? null,
    enabled: true,
    nextDueAt: nextDue,
  };
  const [row] = await db.insert(reminders).values(newRow).returning();
  return row!;
}

export type UpdateReminderInput = {
  id: number;
  title?: string;
  extraPrompt?: string | null;
  schedule?: ReminderSchedule;
  enabled?: boolean;
};

export async function updateReminder(input: UpdateReminderInput): Promise<Reminder | null> {
  const patch: Partial<NewReminder> = { updatedAt: new Date() };
  if (input.title !== undefined) patch.title = input.title;
  if (input.extraPrompt !== undefined) patch.extraPrompt = input.extraPrompt;
  if (input.schedule !== undefined) {
    patch.schedule = input.schedule;
    patch.nextDueAt = computeNextDueAt(input.schedule, null);
  }
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  const [row] = await db
    .update(reminders)
    .set(patch)
    .where(eq(reminders.id, input.id))
    .returning();
  return row ?? null;
}

export async function deleteReminder(id: number): Promise<boolean> {
  const [row] = await db.delete(reminders).where(eq(reminders.id, id)).returning();
  return !!row;
}

export async function deleteRemindersByRef(refTable: string, refId: number): Promise<number> {
  const rows = await db
    .delete(reminders)
    .where(and(eq(reminders.refTable, refTable), eq(reminders.refId, refId)))
    .returning({ id: reminders.id });
  return rows.length;
}

export async function getReminder(id: number): Promise<Reminder | null> {
  const [row] = await db.select().from(reminders).where(eq(reminders.id, id)).limit(1);
  return row ?? null;
}

export async function listReminders(opts: {
  sessionId?: string;
  enabled?: boolean;
  refTable?: string;
  refId?: number;
}): Promise<Reminder[]> {
  const conds = [];
  if (opts.sessionId) conds.push(eq(reminders.sessionId, opts.sessionId));
  if (opts.enabled !== undefined) conds.push(eq(reminders.enabled, opts.enabled));
  if (opts.refTable) conds.push(eq(reminders.refTable, opts.refTable));
  if (opts.refId !== undefined) conds.push(eq(reminders.refId, opts.refId));
  return db
    .select()
    .from(reminders)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(reminders.nextDueAt), asc(reminders.id));
}

// ───── 発火対象取得 + 次回計算 ─────

/**
 * 今 fire すべき (= enabled かつ next_due_at <= now()) reminders を取得。
 * dispatcher (1 分間隔) が毎ターン呼ぶ。
 */
export async function getDueReminders(now: Date = new Date()): Promise<Reminder[]> {
  return db
    .select()
    .from(reminders)
    .where(and(eq(reminders.enabled, true), lte(reminders.nextDueAt, now)))
    .orderBy(asc(reminders.nextDueAt));
}

/**
 * 発火を記録 + 次回 due を更新。
 *
 * ⚠️ アトミック claim: tick が overlap した場合の二重発火を防ぐため、UPDATE 条件に
 * `nextDueAt = <読み取った時の値>` を入れて「前の tick で既に進めた行」を弾く。
 * RETURNING で 1 行返れば claim 成功、空なら他 tick に取られた = 何もせず false。
 * caller は false の場合「自分は発火させない」判断を取る。
 */
export async function markFired(
  reminder: Reminder,
  firedAt: Date = new Date()
): Promise<boolean> {
  const next = computeNextDueAt(reminder.schedule, firedAt);
  const patch: Partial<NewReminder> = {
    lastFiredAt: firedAt,
    fireCount: reminder.fireCount + 1,
    nextDueAt: next,
    updatedAt: firedAt,
  };
  if (reminder.schedule.kind === "once") patch.enabled = false;
  // nextDueAt の値で claim (= overlap した tick が同じ row を update 出来ない)
  const claimed = await db
    .update(reminders)
    .set(patch)
    .where(
      and(
        eq(reminders.id, reminder.id),
        // null safe な比較 — reminder.nextDueAt は schema 上 not null だが念のため
        reminder.nextDueAt !== null
          ? eq(reminders.nextDueAt, reminder.nextDueAt)
          : eq(reminders.id, reminder.id) // fallback (= 旧 row が null だった場合は通常 update)
      )
    )
    .returning({ id: reminders.id });
  return claimed.length > 0;
}

/**
 * schedule + 前回 fire から次回 fire 時刻を計算。
 * once: 一回限りなので最初の 1 回が過ぎたら null (= dispatcher が enabled=false にする)
 * weekly: 直近の該当曜日 + base_time - lead_minutes
 */
export function computeNextDueAt(
  schedule: ReminderSchedule,
  lastFiredAt: Date | null
): Date | null {
  if (schedule.kind === "once") {
    if (lastFiredAt) return null;
    const base = new Date(schedule.baseAt);
    return new Date(base.getTime() - schedule.leadMinutes * 60_000);
  }
  // weekly
  const now = lastFiredAt ?? new Date();
  // JST の今日の年月日 + base_time を起点に、該当曜日まで日数加算
  // weekdays 空配列は毎日扱い
  const weekdays = schedule.weekdays.length > 0 ? schedule.weekdays : [0, 1, 2, 3, 4, 5, 6];
  const [bh, bm] = schedule.baseTime.split(":").map((s) => parseInt(s, 10));
  // 「今」を起点に、最大 8 日先までスキャンして該当曜日の base_time を探す
  for (let i = 0; i < 8; i++) {
    const candidate = new Date(now.getTime() + i * 86400_000);
    // JST の曜日と HH:MM を組み立てる
    const jstParts = new Intl.DateTimeFormat("en-CA", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      weekday: "short",
      hour12: false,
    }).formatToParts(candidate);
    const yyyy = jstParts.find((p) => p.type === "year")!.value;
    const mm = jstParts.find((p) => p.type === "month")!.value;
    const dd = jstParts.find((p) => p.type === "day")!.value;
    const weekdayShort = jstParts.find((p) => p.type === "weekday")!.value; // "Sun"..."Sat"
    const wMap: Record<string, number> = {
      Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
    };
    const w = wMap[weekdayShort] ?? 0;
    if (!weekdays.includes(w)) continue;
    const fireIso = `${yyyy}-${mm}-${dd}T${pad2(bh)}:${pad2(bm)}:00+09:00`;
    const fireBase = new Date(fireIso);
    const fire = new Date(fireBase.getTime() - schedule.leadMinutes * 60_000);
    // 「現在より未来」or「今日が候補でも last_fired_at の翌週まで送る」判定
    if (lastFiredAt) {
      // last_fired_at 当日の同曜日は除外、翌日以降の該当曜日を採用
      if (fire.getTime() <= lastFiredAt.getTime()) continue;
    } else {
      if (fire.getTime() <= now.getTime()) continue;
    }
    return fire;
  }
  return null;
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

// ───── 通知マトリックス連携 (= dispatcher が直接 lookup) ─────

import { notificationSettings } from "@/db/schema";

export type MatrixRule = {
  modeOnline: string;
  modeAway: string;
  modeFocus: string;
  discordPolicy: string;
  importance: string;
};

export async function getMatrixRule(eventKind: string): Promise<MatrixRule | null> {
  const [row] = await db
    .select()
    .from(notificationSettings)
    .where(eq(notificationSettings.eventKind, eventKind))
    .limit(1);
  return row ?? null;
}

// 通知マトリックス用の eventKind は reminder 1 つに集約 (= reminders.kind は内部分類のみ)
export function reminderEventKind(_kind: Reminder["kind"]): "reminder" {
  return "reminder";
}

// ───── speak mode 用 Yui プロンプト ─────

/**
 * dispatcher が speak モード時に Yui に渡す内部プロンプト。
 * Yui (Sonnet) が文脈を読んで自然な発話を生成する。
 */
export function buildFirePrompt(reminders: Reminder[]): string {
  if (reminders.length === 0) return "";
  const head =
    reminders.length === 1
      ? "[リマインダー発火]"
      : `[リマインダー発火 ${reminders.length} 件]`;
  const items = reminders
    .map((r) => {
      const extra = r.extraPrompt ? ` (追加指示: ${r.extraPrompt})` : "";
      return `- 「${r.title}」${extra}`;
    })
    .join("\n");
  const tail =
    reminders.length === 1
      ? "ご主人様に文脈に合った自然な声かけをしてください。機械的に「リマインダーの時間です」とは言わないこと。"
      : "それぞれご主人様に文脈に合った自然な声かけをしてください (まとめて 1 ターンの応答で構いません)。機械的な定型句は避けること。";
  return `${head}\n${items}\n\n${tail}`;
}

// drizzle の or/isNull を re-export しないが、TypeScript の未使用警告対策
void or;
void isNull;
void sql;
