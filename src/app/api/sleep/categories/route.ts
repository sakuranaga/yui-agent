/**
 * GET    /api/sleep/categories         12 カテゴリ一覧 (display_order 順)
 * PATCH  /api/sleep/categories         { id, enabled } で個別 toggle (複数 OK)
 *
 * 設計: docs/sleep-support.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepCategories } from "@/db/schema";
import { asc, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db
    .select()
    .from(sleepCategories)
    .orderBy(asc(sleepCategories.displayOrder));
  return NextResponse.json({
    categories: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      display_order: r.displayOrder,
      enabled: r.enabled,
    })),
  });
}

export async function PATCH(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { updates?: Array<{ id: number; enabled: boolean }> }
    | null;
  const updates = body?.updates;
  if (!Array.isArray(updates) || updates.length === 0) {
    return NextResponse.json({ error: "updates required" }, { status: 400 });
  }
  for (const u of updates) {
    if (typeof u.id !== "number" || typeof u.enabled !== "boolean") continue;
    await db
      .update(sleepCategories)
      .set({ enabled: u.enabled })
      .where(eq(sleepCategories.id, u.id));
  }
  return NextResponse.json({ ok: true });
}
