/**
 * GET /api/logs/briefs?limit=30
 *   morning_briefs を最新順で返す。LogModal の「ブリーフィング」タブ用。
 */
import { NextResponse, type NextRequest } from "next/server";
import { listMorningBriefs } from "@/lib/morning-briefs";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 30;
  try {
    const rows = await listMorningBriefs(limit);
    return NextResponse.json({
      briefs: rows.map((b) => ({
        id: Number(b.id),
        entryDate: b.entryDate.toISOString(),
        generatedAt: b.generatedAt.toISOString(),
        markdown: b.markdown,
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "logs/briefs", message: "ブリーフィング一覧の取得に失敗しました" });
  }
}
