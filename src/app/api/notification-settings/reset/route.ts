/**
 * POST /api/notification-settings/reset
 *   全 event_kind を default に戻す。
 */
import { NextResponse, type NextRequest } from "next/server";
import { resetAllRules } from "@/lib/notification-settings";
import { clientError } from "@/lib/api-error";

export async function POST(req: NextRequest) {
  try {
    await resetAllRules();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "notification-settings/reset", message: "通知設定のリセットに失敗しました" });
  }
}
