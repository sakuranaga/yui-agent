/**
 * PATCH  /api/sleep/affirmations/[id]   { text?, category?, enabled? }
 * DELETE /api/sleep/affirmations/[id]
 *
 * 設計: docs/sleep-support.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepAffirmations } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

function parseId(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const num = parseId(id);
  if (num === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as
    | { text?: string; category?: string | null; enabled?: boolean }
    | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const patch: { text?: string; category?: string | null; enabled?: boolean } = {};
  if (typeof body.text === "string") {
    const t = body.text.trim();
    if (!t) return NextResponse.json({ error: "text cannot be empty" }, { status: 400 });
    patch.text = t;
  }
  if (body.category !== undefined) {
    patch.category =
      body.category === null ? null : String(body.category).trim() || null;
  }
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no updatable fields" }, { status: 400 });
  }

  const [updated] = await db
    .update(sleepAffirmations)
    .set(patch)
    .where(eq(sleepAffirmations.id, num))
    .returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    affirmation: {
      id: Number(updated.id),
      text: updated.text,
      category: updated.category,
      enabled: updated.enabled,
      created_at: updated.createdAt.toISOString(),
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const num = parseId(id);
  if (num === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });
  await db.delete(sleepAffirmations).where(eq(sleepAffirmations.id, num));
  return NextResponse.json({ ok: true });
}
