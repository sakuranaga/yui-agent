/**
 * GET /api/tts-dictionary
 *   全エントリ (enabled 含む) を返す。Settings UI 用。
 * POST /api/tts-dictionary
 *   新規エントリ追加。body: { word, reading, enabled? }
 */
import { NextResponse, type NextRequest } from "next/server";
import { asc } from "drizzle-orm";
import { db } from "@/db/client";
import { ttsDictionary } from "@/db/schema";
import { invalidateDictionaryCache } from "@/lib/tts-dictionary";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const rows = await db
      .select()
      .from(ttsDictionary)
      .orderBy(asc(ttsDictionary.word));
    return NextResponse.json({
      count: rows.length,
      entries: rows.map((r) => ({
        id: Number(r.id),
        word: r.word,
        reading: r.reading,
        enabled: r.enabled,
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
      })
      .onConflictDoUpdate({
        target: ttsDictionary.word,
        set: { reading, enabled: body.enabled ?? true, updatedAt: new Date() },
      })
      .returning();
    invalidateDictionaryCache();
    return NextResponse.json({ ok: true, entry: inserted });
  } catch (e) {
    return clientError(req, e, { context: "tts-dictionary", message: "辞書エントリの追加に失敗しました" });
  }
}
