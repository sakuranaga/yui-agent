/**
 * GET /api/settings/google-status
 *
 * /settings ページから fetch されて連携状態を返す。
 */
import { NextResponse, type NextRequest } from "next/server";
import { getConnectionStatus } from "@/lib/google-oauth";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const status = await getConnectionStatus();
    return NextResponse.json(status);
  } catch (e) {
    return clientError(req, e, {
      context: "settings/google-status",
      message: "Google 連携状態の取得に失敗しました",
    });
  }
}
