/**
 * GET /api/diary?from=YYYY-MM-DD&to=YYYY-MM-DD&q=&limit=30
 *   日付範囲 + キーワード で diary を返す (新しい順)
 */
import { NextResponse, type NextRequest } from "next/server";
import { listDiary, searchDiary } from "@/lib/diary";
import { clientError } from "@/lib/api-error";

// 書き直し直後の再 fetch で旧データが返らないよう、常に再評価する
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const from = req.nextUrl.searchParams.get("from") ?? undefined;
  const to = req.nextUrl.searchParams.get("to") ?? undefined;
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 365) : 30;
  try {
    const list = q && q.length > 0
      ? await searchDiary(q, limit)
      : await listDiary({ from, to, limit });
    return NextResponse.json({
      count: list.length,
      entries: list.map((e) => ({
        id: Number(e.id),
        entry_date: e.entryDate.toISOString().slice(0, 10),
        body: e.body,
        body_tts: e.bodyTts,
        mood: e.mood,
        generated_at: e.generatedAt.toISOString(),
        model_used: e.modelUsed,
        source_meta: e.sourceMeta,
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "diary", message: "日記一覧の取得に失敗しました" });
  }
}
