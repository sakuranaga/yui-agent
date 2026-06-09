/**
 * POST /api/memory/[id]/invalidate   — invalidate (soft delete、retrieval から非表示、行は残す)
 * DELETE /api/memory/[id]/invalidate — invalidate を解除 (再有効化)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { memoryChunks } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import { invalidateChunk } from "@/lib/memory";
import { clientError } from "@/lib/api-error";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    await invalidateChunk({
      chunkId: numId,
      reason: "manual_user_invalidate",
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "memory/[id]/invalidate", message: "記憶の無効化に失敗しました" });
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
    await db
      .update(memoryChunks)
      .set({
        invalidatedAt: null,
        metadata: sql`COALESCE(metadata, '{}'::jsonb) || '{"revalidated_by_user": true}'::jsonb`,
      })
      .where(eq(memoryChunks.id, numId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "memory/[id]/invalidate", message: "記憶の再有効化に失敗しました" });
  }
}
