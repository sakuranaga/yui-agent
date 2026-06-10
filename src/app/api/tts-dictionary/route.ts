/**
 * GET /api/tts-dictionary
 *   辞書エントリをページング + 検索で返す (= 13 万件規模対応、Settings UI 用)。
 *   query: q (検索語) / limit (既定 100, 上限 500) / offset / source (フィルタ)
 *     - q が ASCII (= 英字)        → lower(word) LIKE 'q%' の前方一致 (= index 使用)
 *     - q がそれ以外 (= かな/漢字)  → reading ILIKE '%q%' の部分一致 (= 副次経路)
 *     - source 指定時は user|preset|cmudict で絞り込み
 *   返却: { count(= 該当総数), entries, limit, offset, hasMore }
 * POST /api/tts-dictionary
 *   新規エントリ追加 / 既存上書き。body: { word, reading, enabled? }。source は 'user' を主張。
 */
import { NextResponse, type NextRequest } from "next/server";
import { and, asc, count, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import { ttsDictionary } from "@/db/schema";
import { invalidateDictionaryCache } from "@/lib/tts-dictionary";
import { clientError } from "@/lib/api-error";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;
const VALID_SOURCES = new Set(["user", "preset", "cmudict"]);

/** LIKE のメタ文字 (% _ \) を literal 化する。 */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const q = (sp.get("q") ?? "").trim();
    const sourceFilter = sp.get("source") ?? "";
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(sp.get("limit")) || DEFAULT_LIMIT));
    const offset = Math.max(0, Number(sp.get("offset")) || 0);

    const conds: SQL[] = [];
    if (q) {
      // ASCII (= 英字想定) は word 前方一致で index を使う。それ以外は reading 部分一致。
      if (/^[\x00-\x7F]+$/.test(q)) {
        const pattern = `${escapeLike(q.toLowerCase())}%`;
        conds.push(sql`lower(${ttsDictionary.word}) LIKE ${pattern} ESCAPE '\\'`);
      } else {
        const pattern = `%${escapeLike(q)}%`;
        conds.push(sql`${ttsDictionary.reading} ILIKE ${pattern} ESCAPE '\\'`);
      }
    }
    if (sourceFilter && VALID_SOURCES.has(sourceFilter)) {
      conds.push(eq(ttsDictionary.source, sourceFilter));
    }
    const where = conds.length ? and(...conds) : undefined;

    const [{ total }] = await db
      .select({ total: count() })
      .from(ttsDictionary)
      .where(where);

    const rows = await db
      .select()
      .from(ttsDictionary)
      .where(where)
      .orderBy(asc(ttsDictionary.word))
      .limit(limit)
      .offset(offset);

    return NextResponse.json({
      count: total,
      limit,
      offset,
      hasMore: offset + rows.length < total,
      entries: rows.map((r) => ({
        id: Number(r.id),
        word: r.word,
        reading: r.reading,
        enabled: r.enabled,
        source: r.source,
        created_at: r.createdAt.toISOString(),
        updated_at: r.updatedAt.toISOString(),
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "tts-dictionary", message: "読み方辞書の取得に失敗しました" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      word?: string;
      reading?: string;
      enabled?: boolean;
    };
    const word = body.word?.trim();
    const reading = body.reading?.trim();
    if (!word || !reading) {
      return NextResponse.json({ error: "word and reading required" }, { status: 400 });
    }
    const [inserted] = await db
      .insert(ttsDictionary)
      .values({
        word,
        reading,
        enabled: body.enabled ?? true,
        source: "user",
      })
      .onConflictDoUpdate({
        target: ttsDictionary.word,
        // 手動編集は出所を 'user' に引き上げる (= 以後 bulk import で上書きされない)。
        set: { reading, enabled: body.enabled ?? true, source: "user", updatedAt: new Date() },
      })
      .returning();
    invalidateDictionaryCache();
    return NextResponse.json({ ok: true, entry: inserted });
  } catch (e) {
    return clientError(req, e, { context: "tts-dictionary", message: "辞書エントリの追加に失敗しました" });
  }
}
