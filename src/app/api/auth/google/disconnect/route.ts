/**
 * POST /api/auth/google/disconnect
 *
 * Google 側 revoke + DB から token 削除。
 */
import { NextResponse, type NextRequest } from "next/server";
import { disconnectGoogle } from "@/lib/google-oauth";
import { clientError } from "@/lib/api-error";

export async function POST(req: NextRequest) {
  try {
    await disconnectGoogle();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, {
      status: 500,
      message: "Google 連携解除に失敗しました",
      context: "auth/google/disconnect",
    });
  }
}
