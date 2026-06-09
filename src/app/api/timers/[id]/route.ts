/**
 * DELETE /api/timers/<id>
 *   → タイマー / アラームを取り消し。frontend の × ボタンから呼ばれる。
 */
import { NextResponse, type NextRequest } from "next/server";
import { cancelTimer } from "@/lib/timers";
import { clientError } from "@/lib/api-error";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const ok = await cancelTimer(numId);
    return NextResponse.json({ cancelled: ok, id: numId });
  } catch (e) {
    return clientError(req, e, { context: "timers/[id]", message: "タイマーの取消に失敗しました" });
  }
}
