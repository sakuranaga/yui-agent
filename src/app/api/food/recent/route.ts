/**
 * GET /api/food/recent?limit=20
 *   直近の食事ログ (Phase 1 動作確認用、UI は Phase 2)。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { foodLogs } from "@/db/schema";
import { desc } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "20", 10);
  const limit = Number.isFinite(limitRaw) ? Math.max(1, Math.min(limitRaw, 100)) : 20;
  const rows = await db
    .select()
    .from(foodLogs)
    .orderBy(desc(foodLogs.eatenAt))
    .limit(limit);
  return NextResponse.json({
    count: rows.length,
    logs: rows.map((r) => ({
      id: Number(r.id),
      eatenAt: r.eatenAt.toISOString(),
      rawText: r.rawText,
      items: r.items,
      totalKcal: r.totalKcal,
      totalProtein: r.totalProtein,
      totalCarbs: r.totalCarbs,
      totalFat: r.totalFat,
      totalFiber: r.totalFiber,
      totalSalt: r.totalSalt,
      confidence: r.confidence,
      createdAt: r.createdAt.toISOString(),
    })),
  });
}
