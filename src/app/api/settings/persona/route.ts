/**
 * GET /api/settings/persona — 現在の persona 設定を返す
 * PUT /api/settings/persona — 設定を更新 (部分 update OK)
 */
import { NextResponse, type NextRequest } from "next/server";
import { loadPersona, savePersona, type PersonaUpdate } from "@/lib/persona";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  try {
    const p = await loadPersona();
    return NextResponse.json(p);
  } catch (e) {
    return clientError(req, e, { context: "settings/persona", message: "ペルソナ設定の取得に失敗しました" });
  }
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }

  // 受け付けるフィールドだけ抜き出し (whitelist)
  const update: PersonaUpdate = {};
  const b = body as Record<string, unknown>;
  if (typeof b.secretaryName === "string") update.secretaryName = b.secretaryName;
  if (typeof b.secretaryNameReading === "string")
    update.secretaryNameReading = b.secretaryNameReading;
  if (typeof b.userAddressWork === "string") update.userAddressWork = b.userAddressWork;
  if (typeof b.userAddressRelax === "string") update.userAddressRelax = b.userAddressRelax;
  if (b.currentMode === "auto" || b.currentMode === "work" || b.currentMode === "relax")
    update.currentMode = b.currentMode;
  // null 明示で「追加なし」、number で指定 preset を有効化
  if (b.activePromptPresetId === null) {
    update.activePromptPresetId = null;
  } else if (typeof b.activePromptPresetId === "number" && Number.isFinite(b.activePromptPresetId)) {
    update.activePromptPresetId = b.activePromptPresetId;
  }

  if (Object.keys(update).length === 0) {
    return NextResponse.json(
      { error: "no recognized fields in body" },
      { status: 400 }
    );
  }

  try {
    const next = await savePersona(update);
    return NextResponse.json(next);
  } catch (e) {
    return clientError(req, e, { status: 400, context: "settings/persona", message: "ペルソナ設定の更新に失敗しました" });
  }
}
