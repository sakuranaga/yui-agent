/**
 * GET /api/sleep/words?cats=1,2,3&maxDiff=2
 *   選択カテゴリの enabled な単語を flat list で返す (Fisher-Yates は client 側)。
 *
 * 設計: docs/sleep-support.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepWords } from "@/db/schema";
import { and, eq, inArray, lte } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const catsRaw = req.nextUrl.searchParams.get("cats") ?? "";
  const maxDiffRaw = req.nextUrl.searchParams.get("maxDiff") ?? "2";
  const cats = catsRaw
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const maxDiff = parseInt(maxDiffRaw, 10);

  if (cats.length === 0) {
    return NextResponse.json({ words: [] });
  }

  const rows = await db
    .select({ word: sleepWords.word, categoryId: sleepWords.categoryId })
    .from(sleepWords)
    .where(
      and(
        inArray(sleepWords.categoryId, cats),
        eq(sleepWords.enabled, true),
        lte(sleepWords.difficulty, Number.isFinite(maxDiff) ? maxDiff : 2)
      )
    );

  return NextResponse.json({
    words: rows.map((r) => r.word),
    count: rows.length,
  });
}
