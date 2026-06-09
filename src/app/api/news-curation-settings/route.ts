/**
 * GET  /api/news-curation-settings        現設定を返す
 * PUT  /api/news-curation-settings        設定を更新
 *
 * 設計: docs/news-curation.md §5, §11
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  getCurationSettings,
  updateCurationSettings,
} from "@/lib/news-curation-settings";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getCurationSettings();
  return NextResponse.json({
    interestProfile: s.interestProfile,
    scoreThreshold: s.scoreThreshold,
    minSpeakIntervalHours: s.minSpeakIntervalHours,
    lastSpokenAt: s.lastSpokenAt ? s.lastSpokenAt.toISOString() : null,
  });
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      interestProfile?: string;
      scoreThreshold?: number;
      minSpeakIntervalHours?: number;
    };
    const patch: {
      interestProfile?: string;
      scoreThreshold?: number;
      minSpeakIntervalHours?: number;
    } = {};
    if (typeof body.interestProfile === "string") {
      patch.interestProfile = body.interestProfile.slice(0, 4000);
    }
    if (typeof body.scoreThreshold === "number") {
      patch.scoreThreshold = Math.max(0, Math.min(1, body.scoreThreshold));
    }
    if (typeof body.minSpeakIntervalHours === "number") {
      patch.minSpeakIntervalHours = Math.max(
        0,
        Math.min(168, Math.floor(body.minSpeakIntervalHours))
      );
    }
    await updateCurationSettings(patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { status: 400, context: "news-curation-settings", message: "ニュースキュレーション設定の更新に失敗しました" });
  }
}
