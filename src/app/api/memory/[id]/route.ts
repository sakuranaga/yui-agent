/**
 * PATCH  /api/memory/[id]    body: { content?, owner?, importance?, chunkType? }
 *   1 行更新。content を変更したら embedding を再計算。
 *
 * DELETE /api/memory/[id]
 *   物理削除 (取り消し不可)。invalidate (soft) は別エンドポイント。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { memoryChunks } from "@/db/schema";
import { eq } from "drizzle-orm";
import { embed } from "@/lib/embed";
import { clientError } from "@/lib/api-error";

const VALID_TYPES = new Set([
  "fact",
  "preference",
  "event",
  "emotion",
  "summary",
  "turn_summary",
  "procedural",
  "commitment",
  "task_result",
  "external_ref",
]);
const VALID_OWNERS = new Set(["user", "assistant", "shared"]);

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as {
      content?: string;
      owner?: string;
      importance?: number;
      chunkType?: string;
    };
    const patch: Record<string, unknown> = {};
    if (body.content !== undefined) {
      if (body.content.trim().length === 0) {
        return NextResponse.json({ error: "content must not be empty" }, { status: 400 });
      }
      patch.content = body.content;
      // 内容が変わったら embedding を再計算
      const [emb] = await embed([body.content]);
      patch.embedding = emb;
    }
    if (body.owner !== undefined) {
      if (!VALID_OWNERS.has(body.owner)) {
        return NextResponse.json({ error: "invalid owner" }, { status: 400 });
      }
      patch.owner = body.owner;
    }
    if (body.importance !== undefined) {
      patch.importance = Math.max(0, Math.min(1, body.importance));
    }
    if (body.chunkType !== undefined) {
      if (!VALID_TYPES.has(body.chunkType)) {
        return NextResponse.json({ error: "invalid chunkType" }, { status: 400 });
      }
      patch.chunkType = body.chunkType;
    }
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }
    const [row] = await db
      .update(memoryChunks)
      .set(patch)
      .where(eq(memoryChunks.id, numId))
      .returning();
    if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "memory/[id]", message: "記憶の更新に失敗しました" });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    await db.delete(memoryChunks).where(eq(memoryChunks.id, numId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "memory/[id]", message: "記憶の削除に失敗しました" });
  }
}
