/**
 * POST /api/sleep/intro
 *   睡眠サポート開始時の導入セリフ (結衣の声) を Sonnet で生成して返す。
 *   実 TTS 再生は client 側 (SleepModal の runtime engine) で /api/tts を叩く。
 *
 * 設計: docs/sleep-support.md (Phase 2)
 */
import { NextResponse, type NextRequest } from "next/server";
import { generateSleepIntro } from "@/lib/sleep-intro";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const text = await generateSleepIntro();
    return NextResponse.json({ text });
  } catch (e) {
    return clientError(req, e, {
      status: 502,
      context: "sleep/intro",
      message: "睡眠サポートのセリフ生成に失敗しました",
    });
  }
}
