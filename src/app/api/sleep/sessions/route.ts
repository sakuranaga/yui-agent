/**
 * POST /api/sleep/sessions
 *   { categories: number[], bgmId: number|null, timerMin: number|null }
 *   セッション開始記録を作って id を返す。
 *
 * 設計: docs/sleep-support.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepSessions, sleepCategories } from "@/db/schema";
import { inArray } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { categories?: number[]; bgmId?: number | null; timerMin?: number | null }
    | null;

  const catIds = Array.isArray(body?.categories)
    ? body!.categories.filter((n) => typeof n === "number" && Number.isFinite(n))
    : [];

  // 表示用に category 名を解決して text[] で保存 (将来 categories 表が変わっても残る)
  let catNames: string[] = [];
  if (catIds.length > 0) {
    const rows = await db
      .select({ name: sleepCategories.name })
      .from(sleepCategories)
      .where(inArray(sleepCategories.id, catIds));
    catNames = rows.map((r) => r.name);
  }

  const [inserted] = await db
    .insert(sleepSessions)
    .values({
      categories: catNames,
      bgmId: typeof body?.bgmId === "number" ? body!.bgmId : null,
      timerMin: typeof body?.timerMin === "number" ? body!.timerMin : null,
    })
    .returning({ id: sleepSessions.id });

  return NextResponse.json({ id: Number(inserted.id) });
}
