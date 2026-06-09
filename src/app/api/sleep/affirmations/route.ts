/**
 * GET   /api/sleep/affirmations            一覧 (新しい順)
 * POST  /api/sleep/affirmations { text, category? }   新規作成
 *
 * 個別 update/delete は /api/sleep/affirmations/[id]
 *
 * 設計: docs/sleep-support.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepAffirmations } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET() {
  const rows = await db
    .select()
    .from(sleepAffirmations)
    .orderBy(desc(sleepAffirmations.createdAt));
  return NextResponse.json({
    affirmations: rows.map((r) => ({
      id: Number(r.id),
      text: r.text,
      category: r.category,
      enabled: r.enabled,
      created_at: r.createdAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { text?: string; category?: string | null }
    | null;
  const text = body?.text?.trim();
  if (!text) {
    return NextResponse.json({ error: "text required" }, { status: 400 });
  }
  const category = body?.category?.trim() || null;
  const [inserted] = await db
    .insert(sleepAffirmations)
    .values({ text, category })
    .returning();
  return NextResponse.json({
    affirmation: {
      id: Number(inserted.id),
      text: inserted.text,
      category: inserted.category,
      enabled: inserted.enabled,
      created_at: inserted.createdAt.toISOString(),
    },
  });
}
