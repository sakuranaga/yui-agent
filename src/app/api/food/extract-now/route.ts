/**
 * POST /api/food/extract-now?session=<sid>
 *   debounce を待たずに食事抽出を即実行 (動作確認用)。
 *   Phase 1 内なら残しておいて、Phase 2 以降で削除しても OK。
 */
import { NextResponse, type NextRequest } from "next/server";
import { runExtractNow } from "@/lib/food-extract";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session");
  if (!session) {
    return NextResponse.json({ error: "session param required" }, { status: 400 });
  }
  try {
    await runExtractNow(session);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "food/extract-now", message: "食事抽出の実行に失敗しました" });
  }
}
