/**
 * POST /api/tts-preview
 *   { text: string } を受け取り、TTS 前処理パイプライン
 *   (辞書置換 + Haiku LLM 正規化) を通した結果を返す。
 *
 *   読み方タブのテストエリアから呼ばれ、フロント側は返ってきた
 *   normalized テキストを window.__yuiSpeakText に渡して読み上げる。
 *
 * レスポンス: { normalized: string, original: string }
 *   失敗時は normalized = original (raw) にフォールバック。
 */
import { NextResponse, type NextRequest } from "next/server";
import { normalizeForTTS } from "@/lib/tts-normalize";
import { clientError } from "@/lib/api-error";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { text?: unknown };
    const text = typeof body.text === "string" ? body.text : "";
    if (!text.trim()) {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }
    const normalized = await normalizeForTTS(text);
    return NextResponse.json({
      normalized: normalized ?? text,
      original: text,
    });
  } catch (e) {
    return clientError(req, e, { context: "tts-preview", message: "TTS プレビューに失敗しました" });
  }
}
