/**
 * GET /api/contacts/companies
 *   contacts 内のユニーク会社名一覧を、利用件数の多い順 → 名前昇順で返す。
 *   ContactsModal の会社ピッカー (project ピッカー相当) で使う。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { sql } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const rows = await db
      .select({
        name: contacts.company,
        count: sql<number>`COUNT(*)::int`,
      })
      .from(contacts)
      .where(sql`${contacts.company} IS NOT NULL AND ${contacts.company} <> '' AND ${contacts.deletedAt} IS NULL`)
      .groupBy(contacts.company)
      .orderBy(sql`COUNT(*) DESC, ${contacts.company} ASC`);
    return NextResponse.json({
      companies: rows.map((r) => ({ name: r.name as string, count: r.count })),
    });
  } catch (e) {
    return clientError(req, e, { context: "contacts/companies", message: "会社一覧の取得に失敗しました" });
  }
}
