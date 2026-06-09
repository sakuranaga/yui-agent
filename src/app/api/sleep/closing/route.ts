/**
 * POST /api/sleep/closing
 *   セッション終了 (timer 終了 / 手動停止) 時の締めセリフを返す。
 *
 * 設計: docs/sleep-support.md (Phase 2/4)
 */
import { NextResponse, type NextRequest } from "next/server";
import { generateSleepClosing } from "@/lib/sleep-intro";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const text = await generateSleepClosing();
    return NextResponse.json({ text });
  } catch (e) {
    return clientError(req, e, {
      status: 502,
      context: "sleep/closing",
      message: "睡眠サポートのセリフ生成に失敗しました",
    });
  }
}
