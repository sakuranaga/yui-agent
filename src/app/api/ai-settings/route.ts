/**
 * GET  /api/ai-settings        全 key 取得 (シークレットマスク済み)
 * PUT  /api/ai-settings        部分更新 (シークレット "" or "***" は無変更)
 *
 * 設計: docs/ai-settings.md §5
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  getAllAiSettings,
  updateAiSettings,
  type AiSettingKey,
} from "@/lib/ai-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const settings = await getAllAiSettings({ masked: true });
  return NextResponse.json({ settings });
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<Record<AiSettingKey, unknown>>;
    const patch: Partial<Record<AiSettingKey, string>> = {};
    for (const [k, v] of Object.entries(body)) {
      if (typeof v === "string") {
        patch[k as AiSettingKey] = v;
      } else if (typeof v === "number" || typeof v === "boolean") {
        patch[k as AiSettingKey] = String(v);
      }
    }
    await updateAiSettings(patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const { clientError } = await import("@/lib/api-error");
    return clientError(undefined, e, {
      status: 400,
      message: "AI 設定の更新に失敗しました",
      context: "ai-settings",
    });
  }
}
