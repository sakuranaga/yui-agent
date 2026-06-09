/**
 * POST /api/diary/[date]/regenerate
 * 指定日の日記を再生成 (UI からの "もう一度書き直して" ボタン用)
 */
import { NextResponse, type NextRequest } from "next/server";
import { generateDiaryEntry } from "@/lib/diary";
import { clientError } from "@/lib/api-error";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ date: string }> }
) {
  const { date } = await params;
  try {
    // date は YYYY-MM-DD。JST 00:00 の Date を組み立てて渡す
    const targetDate = new Date(`${date}T12:00:00+09:00`); // 日中で安全に
    const entry = await generateDiaryEntry({ date: targetDate });
    return NextResponse.json({ ok: true, entry });
  } catch (e) {
    return clientError(req, e, { context: "diary/[date]/regenerate", message: "日記の再生成に失敗しました" });
  }
}
