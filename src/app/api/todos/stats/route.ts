/**
 * GET /api/todos/stats?project=<name|__no_project__|>
 *   選択中のプロジェクトに対する TODO 件数サマリを返す。
 *   project 未指定 = 全プロジェクト横断。
 *
 * レスポンス:
 *   {
 *     byState: { backlog, in_progress, blocked, done },
 *     doneToday: number,    // 今日完了
 *     doneThisWeek: number, // 今週月曜〜今日完了
 *   }
 *
 * 「完了」は累積するので率では使わず、ここでは未完了 state を主役にしつつ
 * 「今日 / 今週の完了数」だけ別枠で motivation 用に返す。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { projects, todos } from "@/db/schema";
import { and, eq, sql, type SQL, isNull, gte } from "drizzle-orm";

function jstStartOfTodayUtc(): Date {
  // JST 00:00 = UTC 前日 15:00
  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const ymd = `${get("year")}-${get("month")}-${get("day")}`;
  return new Date(`${ymd}T00:00:00+09:00`);
}

function jstStartOfWeekUtc(): Date {
  // 月曜起算 (ISO 週)。JST で今日の dow → 月曜までの日数を引く。
  const today = jstStartOfTodayUtc();
  // getUTCDay は UTC 日曜=0,...。JST 表示日を出すために JST に変換した日付の曜日が必要。
  // 簡略化: today (UTC) を Asia/Tokyo で weekday を取得
  const dowStr = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Tokyo",
    weekday: "short",
  }).format(today);
  const map: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  const offset = map[dowStr] ?? 0;
  return new Date(today.getTime() - offset * 86_400_000);
}

export async function GET(req: NextRequest) {
  const project = req.nextUrl.searchParams.get("project");
  const conds: SQL[] = [];
  if (project === "__no_project__") {
    conds.push(isNull(todos.projectId));
  } else if (project) {
    const [p] = await db.select().from(projects).where(eq(projects.name, project)).limit(1);
    if (!p) {
      return NextResponse.json({
        byState: { backlog: 0, in_progress: 0, blocked: 0, done: 0 },
        doneToday: 0,
        doneThisWeek: 0,
      });
    }
    conds.push(eq(todos.projectId, p.id));
  }

  const baseWhere = conds.length > 0 ? and(...conds) : undefined;

  // state 別件数
  const stateCounts = await db
    .select({
      state: todos.state,
      count: sql<number>`COUNT(*)::int`,
    })
    .from(todos)
    .where(baseWhere)
    .groupBy(todos.state);

  const byState: Record<"backlog" | "in_progress" | "blocked" | "done", number> = {
    backlog: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  };
  for (const r of stateCounts) {
    if (r.state in byState) byState[r.state as keyof typeof byState] = r.count;
  }

  // 期間限定: 今日完了 / 今週完了
  const todayStart = jstStartOfTodayUtc();
  const weekStart = jstStartOfWeekUtc();

  const doneTodayConds = [...conds, eq(todos.state, "done"), gte(todos.completedAt, todayStart)];
  const doneThisWeekConds = [...conds, eq(todos.state, "done"), gte(todos.completedAt, weekStart)];

  const [{ count: doneToday }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(todos)
    .where(and(...doneTodayConds));

  const [{ count: doneThisWeek }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(todos)
    .where(and(...doneThisWeekConds));

  return NextResponse.json({ byState, doneToday, doneThisWeek });
}
