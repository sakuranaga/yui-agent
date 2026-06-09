/**
 * GET  /api/vrm/current        現在表示すべきモデルを返す。
 *   優先順位: manual_override → current → is_default → null
 *   返却: { model: {id,name,filename,thumbnail_filename} | null }
 * POST /api/vrm/current  { modelId }
 *   手動切替。manual_override_model_id = modelId, current_model_id = modelId に。
 *
 * 設計: docs/vrm-wardrobe.md (Phase 1)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { vrmModels, vrmSettings } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

async function loadSettings() {
  const rows = await db.select().from(vrmSettings).where(eq(vrmSettings.id, 1));
  if (rows.length === 0) {
    await db.insert(vrmSettings).values({ id: 1 }).onConflictDoNothing();
    const r2 = await db.select().from(vrmSettings).where(eq(vrmSettings.id, 1));
    return r2[0];
  }
  return rows[0];
}

async function resolveCurrentModelId(): Promise<number | null> {
  const s = await loadSettings();
  if (s.manualOverrideModelId !== null) return Number(s.manualOverrideModelId);
  if (s.currentModelId !== null) return Number(s.currentModelId);
  // fallback: is_default の最初のモデル
  const [def] = await db
    .select({ id: vrmModels.id })
    .from(vrmModels)
    .where(and(eq(vrmModels.isDefault, true), eq(vrmModels.enabled, true)))
    .limit(1);
  return def ? Number(def.id) : null;
}

export async function GET() {
  const id = await resolveCurrentModelId();
  if (id === null) return NextResponse.json({ model: null });
  const [row] = await db.select().from(vrmModels).where(eq(vrmModels.id, id));
  if (!row) return NextResponse.json({ model: null });
  return NextResponse.json({
    model: {
      id: Number(row.id),
      name: row.name,
      filename: row.filename,
      thumbnail_filename: row.thumbnailFilename,
    },
  });
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as { modelId?: number } | null;
  const mid = typeof body?.modelId === "number" ? body.modelId : NaN;
  if (!Number.isFinite(mid) || mid <= 0) {
    return NextResponse.json({ error: "modelId required" }, { status: 400 });
  }
  // 存在チェック
  const [exists] = await db.select({ id: vrmModels.id }).from(vrmModels).where(eq(vrmModels.id, mid));
  if (!exists) return NextResponse.json({ error: "model not found" }, { status: 404 });

  await loadSettings();
  await db
    .update(vrmSettings)
    .set({
      currentModelId: mid,
      manualOverrideModelId: mid,
      updatedAt: new Date(),
    })
    .where(eq(vrmSettings.id, 1));

  return NextResponse.json({ ok: true, currentModelId: mid });
}
