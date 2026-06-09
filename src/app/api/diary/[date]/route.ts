/**
 * GET  /api/diary/[date]  — 指定日 (YYYY-MM-DD) のエントリ取得
 * POST /api/diary/[date]/regenerate — 指定日の日記を再生成 (Yui tool / 手動 UI 用)
 */
import { NextResponse, type NextRequest } from "next/server";
import { getDiaryEntry } from "@/lib/diary";
import { clientError } from "@/lib/api-error";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date } = await params;
  try {
    const entry = await getDiaryEntry(date);
    if (!entry) return NextResponse.json({ entry: null });
    return NextResponse.json({
      entry: {
        id: Number(entry.id),
        entry_date: entry.entryDate.toISOString().slice(0, 10),
        body: entry.body,
        mood: entry.mood,
        generated_at: entry.generatedAt.toISOString(),
        model_used: entry.modelUsed,
        source_meta: entry.sourceMeta,
      },
    });
  } catch (e) {
    return clientError(req, e, { context: "diary/[date]", message: "日記の取得に失敗しました" });
  }
}
