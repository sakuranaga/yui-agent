/**
 * GET /api/mail/contacts-search?q=<query>&limit=20
 *   メアド検索専用の contacts subset を返す (Compose Modal の宛先 autocomplete / popup 用)。
 *   emails が 1 件もない連絡先は除外。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { isNull, sql, and } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

type ContactRow = {
  id: number;
  name: string;
  kana: string | null;
  company: string | null;
  emails: Array<{ type?: string; value: string }> | null;
};

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim().toLowerCase();
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 20;
  try {
    const rows = await db
      .select({
        id: contacts.id,
        name: contacts.name,
        kana: contacts.kana,
        company: contacts.company,
        emails: contacts.emails,
      })
      .from(contacts)
      .where(
        and(
          isNull(contacts.deletedAt),
          // emails jsonb 配列が 1 件以上ある (Postgres jsonb_array_length)
          sql`jsonb_array_length(${contacts.emails}) > 0`
        )
      )
      .limit(500);

    const lower = (s: string | null | undefined) => (s ?? "").toLowerCase();
    const filtered = q
      ? (rows as ContactRow[]).filter((r) => {
          if (lower(r.name).includes(q)) return true;
          if (lower(r.kana).includes(q)) return true;
          if (lower(r.company).includes(q)) return true;
          if ((r.emails ?? []).some((e) => lower(e.value).includes(q))) return true;
          return false;
        })
      : (rows as ContactRow[]);

    return NextResponse.json({
      contacts: filtered.slice(0, limit).map((r) => ({
        id: Number(r.id),
        name: r.name,
        kana: r.kana,
        company: r.company,
        emails: (r.emails ?? []).map((e) => ({
          type: e.type ?? null,
          value: e.value,
        })),
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "mail/contacts-search", message: "連絡先検索に失敗しました" });
  }
}
