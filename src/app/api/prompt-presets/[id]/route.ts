/**
 * PATCH /api/prompt-presets/[id]
 *   body: { label?, body?, sort_order? }
 *
 * DELETE /api/prompt-presets/[id]
 *   FK が ON DELETE SET NULL なので、有効化中の preset を消したら自動的に
 *   persona_settings.active_prompt_preset_id が NULL になる (= 追加なし扱い)。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { promptPresets } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const b = body as { label?: string; body?: string; sort_order?: number };
  const setValues: Record<string, unknown> = { updatedAt: new Date() };
  if (typeof b.label === "string") {
    if (b.label.trim() === "") {
      return NextResponse.json({ error: "label cannot be empty" }, { status: 400 });
    }
    setValues.label = b.label.trim();
  }
  if (typeof b.body === "string") {
    if (b.body.trim() === "") {
      return NextResponse.json({ error: "body cannot be empty" }, { status: 400 });
    }
    setValues.body = b.body.trim();
  }
  if (typeof b.sort_order === "number") {
    setValues.sortOrder = b.sort_order;
  }
  const updated = await db
    .update(promptPresets)
    .set(setValues)
    .where(eq(promptPresets.id, id))
    .returning();
  if (updated.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  const r = updated[0];
  return NextResponse.json({
    preset: {
      id: Number(r.id),
      label: r.label,
      body: r.body,
      sortOrder: r.sortOrder,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id: idStr } = await ctx.params;
  const id = parseInt(idStr, 10);
  if (!Number.isFinite(id) || id <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  const deleted = await db
    .delete(promptPresets)
    .where(eq(promptPresets.id, id))
    .returning();
  if (deleted.length === 0) {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}
