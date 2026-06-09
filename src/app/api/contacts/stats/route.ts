/**
 * GET /api/contacts/stats?company=<name|__no_company__|>
 *   選択中の会社に対する連絡先サマリを返す。company 未指定 = 全会社横断 (削除済は除く)。
 *
 * レスポンス:
 *   {
 *     total: number,        // 全件 (削除除く)
 *     deleted: number,      // 削除済の件数
 *     recentMonth: number,  // 直近 30 日に最終接触のあった人数
 *     recentWeek: number,   // 直近 7 日に最終接触のあった人数
 *   }
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { and, eq, gte, isNull, isNotNull, sql, type SQL } from "drizzle-orm";

export async function GET(req: NextRequest) {
  const company = req.nextUrl.searchParams.get("company");
  const baseConds: SQL[] = [];
  if (company === "__no_company__") {
    baseConds.push(sql`(${contacts.company} IS NULL OR ${contacts.company} = '')`);
  } else if (company) {
    baseConds.push(eq(contacts.company, company));
  }

  const aliveWhere = and(...baseConds, isNull(contacts.deletedAt));
  const deletedWhere = and(...baseConds, isNotNull(contacts.deletedAt));

  const [{ count: total }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(contacts)
    .where(aliveWhere);

  const [{ count: deleted }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(contacts)
    .where(deletedWhere);

  const now = Date.now();
  const weekAgo = new Date(now - 7 * 86_400_000);
  const monthAgo = new Date(now - 30 * 86_400_000);

  const [{ count: recentWeek }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(contacts)
    .where(and(...baseConds, isNull(contacts.deletedAt), gte(contacts.lastContactAt, weekAgo)));

  const [{ count: recentMonth }] = await db
    .select({ count: sql<number>`COUNT(*)::int` })
    .from(contacts)
    .where(and(...baseConds, isNull(contacts.deletedAt), gte(contacts.lastContactAt, monthAgo)));

  return NextResponse.json({ total, deleted, recentMonth, recentWeek });
}
