/**
 * PATCH /api/tts-dictionary/[id]
 *   body: { word?, reading?, enabled? }
 * DELETE /api/tts-dictionary/[id]
 */
import { NextResponse, type NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { ttsDictionary } from "@/db/schema";
import { invalidateDictionaryCache } from "@/lib/tts-dictionary";
import { clientError } from "@/lib/api-error";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const entryId = parseInt(id, 10);
  if (!Number.isFinite(entryId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as {
      word?: string;
      reading?: string;
      enabled?: boolean;
    };
    const patch: Record<string, unknown> = { updatedAt: new Date() };
    if (body.word !== undefined) patch.word = body.word.trim();
    if (body.reading !== undefined) patch.reading = body.reading.trim();
    if (body.enabled !== undefined) patch.enabled = body.enabled;
    const [updated] = await db
      .update(ttsDictionary)
      .set(patch)
      .where(eq(ttsDictionary.id, entryId))
      .returning();
    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    invalidateDictionaryCache();
    return NextResponse.json({ ok: true, entry: updated });
  } catch (e) {
    return clientError(req, e, { context: "tts-dictionary/[id]", message: "辞書エントリの更新に失敗しました" });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const entryId = parseInt(id, 10);
  if (!Number.isFinite(entryId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const result = await db
      .delete(ttsDictionary)
      .where(eq(ttsDictionary.id, entryId))
      .returning({ id: ttsDictionary.id });
    if (result.length === 0) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    invalidateDictionaryCache();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "tts-dictionary/[id]", message: "辞書エントリの削除に失敗しました" });
  }
}
