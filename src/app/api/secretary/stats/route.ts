/**
 * GET /api/secretary/stats
 *
 * 秘書カード (SecretaryCard) が初期 load と SSE stats_update 受信時に呼ぶ。
 * Yui 自身も get_my_status tool で同じデータを参照する。
 * 実装は src/lib/secretary-stats.ts に集約。
 */
import { NextResponse, type NextRequest } from "next/server";
import { collectSecretaryStats } from "@/lib/secretary-stats";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const stats = await collectSecretaryStats();
    return NextResponse.json(stats);
  } catch (e) {
    return clientError(req, e, { context: "secretary/stats", message: "秘書カードのデータ取得に失敗しました" });
  }
}
