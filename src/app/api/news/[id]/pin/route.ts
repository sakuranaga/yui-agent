/**
 * PATCH /api/news/[id]/pin  body: {pinned: boolean}
 *  - pinned=true  → 3 日 TTL 自動削除から除外
 *  - pinned=false → 通常の TTL 適用に戻す
 */
import { NextResponse, type NextRequest } from "next/server";
import { pinArticle } from "@/lib/news";
import { clientError } from "@/lib/api-error";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as { pinned?: boolean };
    if (typeof body.pinned !== "boolean") {
      return NextResponse.json({ error: "pinned (boolean) required" }, { status: 400 });
    }
    const row = await pinArticle(numId, body.pinned);
    if (!row) return NextResponse.json({ error: "article not found" }, { status: 404 });
    return NextResponse.json({
      ok: true,
      article: {
        id: row.id,
        pinned: row.pinned,
        pinned_at: row.pinnedAt?.toISOString() ?? null,
      },
    });
  } catch (e) {
    return clientError(req, e, { context: "news/[id]/pin", message: "記事の固定設定に失敗しました" });
  }
}
