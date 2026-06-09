/**
 * GET /api/news?source=<id>&pinned_only=1&q=<keyword>&limit=50&before_id=<id>
 *
 * NewsModal が一覧表示で叩く。
 * source は id (number)、または "all" / 省略 で全 source 横断。
 */
import { NextResponse, type NextRequest } from "next/server";
import { listArticles } from "@/lib/news";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  const sourceRaw = req.nextUrl.searchParams.get("source");
  const sourceId =
    sourceRaw && sourceRaw !== "all" ? parseInt(sourceRaw, 10) : undefined;
  const pinnedOnly = req.nextUrl.searchParams.get("pinned_only") === "1";
  const query = req.nextUrl.searchParams.get("q")?.trim() || undefined;
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  const beforeIdRaw = parseInt(req.nextUrl.searchParams.get("before_id") ?? "", 10);
  const beforeId =
    Number.isFinite(beforeIdRaw) && beforeIdRaw > 0 ? beforeIdRaw : undefined;

  try {
    const items = await listArticles({
      sourceId: Number.isFinite(sourceId) ? sourceId : undefined,
      pinnedOnly,
      query,
      limit,
      beforeId,
    });
    return NextResponse.json({
      count: items.length,
      articles: items.map((a) => ({
        id: a.id,
        source_id: a.sourceId,
        source_name: a.sourceName,
        guid: a.guid,
        title: a.title,
        link: a.link,
        summary: a.summary,
        published_at: a.publishedAt.toISOString(),
        fetched_at: a.fetchedAt.toISOString(),
        pinned: a.pinned,
        pinned_at: a.pinnedAt?.toISOString() ?? null,
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "news", message: "ニュース一覧の取得に失敗しました" });
  }
}
