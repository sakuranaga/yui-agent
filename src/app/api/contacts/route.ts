/**
 * GET  /api/contacts?q=&tag=&company=&include_deleted=&before_id=<id>&before_lc=<ISO|""|null>&limit=50
 * POST /api/contacts  body: AddContactInput (sessionId は server デフォルト "ui")
 *
 * ページネーション: ソート順 (last_contact_at DESC NULLS LAST, id DESC) と整合する keyset cursor。
 * before_id 単独だと last_contact_at が違う行で重複する (id 単調順でないため)。
 * client は最後の行の last_contact_at (null なら空文字) と id を一緒に渡す。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { contacts } from "@/db/schema";
import { and, desc, eq, ilike, isNull, or, sql, type SQL } from "drizzle-orm";
import { addContact, type ContactValue } from "@/lib/contacts";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const tag = req.nextUrl.searchParams.get("tag")?.trim();
  const company = req.nextUrl.searchParams.get("company")?.trim();
  const includeDeleted = req.nextUrl.searchParams.get("include_deleted") === "1";
  const onlyRecent = req.nextUrl.searchParams.get("only_recent") === "1";
  const beforeIdRaw = parseInt(req.nextUrl.searchParams.get("before_id") ?? "", 10);
  // before_lc: ISO 文字列 / 空文字 (null 行の cursor) / 未指定 (先頭ページ)
  const beforeLcParam = req.nextUrl.searchParams.get("before_lc");
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  const conds: SQL[] = [];
  if (!includeDeleted) conds.push(isNull(contacts.deletedAt));
  if (onlyRecent) {
    conds.push(sql`${contacts.lastContactAt} IS NOT NULL`);
  }
  // keyset cursor: (last_contact_at, id) lex DESC NULLS LAST より「後ろ」だけ取る
  if (Number.isFinite(beforeIdRaw) && beforeIdRaw > 0 && beforeLcParam !== null) {
    if (beforeLcParam === "") {
      // cursor 行が NULL → NULL 範囲内で id がさらに小さいものだけ
      conds.push(
        sql`${contacts.lastContactAt} IS NULL AND ${contacts.id} < ${beforeIdRaw}`
      );
    } else {
      const beforeLcDate = new Date(beforeLcParam);
      if (!Number.isNaN(beforeLcDate.getTime())) {
        conds.push(
          sql`(${contacts.lastContactAt} < ${beforeLcDate.toISOString()}::timestamptz
               OR (${contacts.lastContactAt} = ${beforeLcDate.toISOString()}::timestamptz AND ${contacts.id} < ${beforeIdRaw})
               OR ${contacts.lastContactAt} IS NULL)`
        );
      }
    }
  }
  if (q && q.length > 0) {
    const like = `%${q}%`;
    const noSpace = q.replace(/[\s　]+/g, "");
    const stripExpr = sql`REPLACE(REPLACE(${contacts.name}, ' ', ''), '　', '')`;
    const variants = new Set<string>([noSpace]);
    if (noSpace.length >= 2 && noSpace.length % 2 === 0) {
      const mid = noSpace.length / 2;
      variants.add(noSpace.slice(mid) + noSpace.slice(0, mid));
    }
    const variantClauses = [...variants].map(
      (v) => sql`${stripExpr} ILIKE ${`%${v}%`}`
    );
    conds.push(
      or(
        ilike(contacts.name, like),
        ilike(contacts.kana, like),
        ilike(contacts.nickname, like),
        ilike(contacts.company, like),
        eq(contacts.identifier, q),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${contacts.emails}) e WHERE e->>'value' ILIKE ${like})`,
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${contacts.phones}) p WHERE p->>'value' ILIKE ${like})`,
        ...variantClauses
      )!
    );
  }
  if (tag) conds.push(sql`${contacts.tags} @> ARRAY[${tag}]::text[]`);
  if (company === "__no_company__") {
    conds.push(sql`(${contacts.company} IS NULL OR ${contacts.company} = '')`);
  } else if (company) {
    conds.push(ilike(contacts.company, `%${company}%`));
  }

  try {
    const rows = await db
      .select()
      .from(contacts)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(
        sql`${contacts.lastContactAt} DESC NULLS LAST`,
        desc(contacts.id)
      )
      .limit(limit);

    return NextResponse.json({
      count: rows.length,
      contacts: rows.map((c) => ({
        id: Number(c.id),
        identifier: c.identifier,
        name: c.name,
        kana: c.kana,
        nickname: c.nickname,
        company: c.company,
        department: c.department,
        role: c.role,
        emails: c.emails,
        phones: c.phones,
        addresses: c.addresses,
        urls: c.urls,
        birthday: c.birthday?.toISOString().slice(0, 10) ?? null,
        tags: c.tags,
        notes: c.notes,
        last_contact_at: c.lastContactAt?.toISOString() ?? null,
        created_at: c.createdAt.toISOString(),
        updated_at: c.updatedAt.toISOString(),
        deleted_at: c.deletedAt?.toISOString() ?? null,
        external_ref: c.externalRef,
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "contacts", message: "連絡先一覧の取得に失敗しました" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      name?: string;
      kana?: string;
      nickname?: string;
      company?: string;
      department?: string;
      role?: string;
      emails?: ContactValue[];
      phones?: ContactValue[];
      addresses?: ContactValue[];
      urls?: string[];
      birthday?: string;
      tags?: string[];
      notes?: string;
      session_id?: string;
    };
    if (!body.name) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const c = await addContact({
      sessionId: body.session_id ?? "ui",
      name: body.name,
      kana: body.kana,
      nickname: body.nickname,
      company: body.company,
      department: body.department,
      role: body.role,
      emails: body.emails,
      phones: body.phones,
      addresses: body.addresses,
      urls: body.urls,
      birthday: body.birthday ? new Date(body.birthday) : undefined,
      tags: body.tags,
      notes: body.notes,
    });
    return NextResponse.json({ ok: true, contact: c });
  } catch (e) {
    return clientError(req, e, { context: "contacts", message: "連絡先の追加に失敗しました" });
  }
}
