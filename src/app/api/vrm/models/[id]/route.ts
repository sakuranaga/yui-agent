/**
 * PATCH  /api/vrm/models/[id]   { name?, isDefault?, enabled? }
 *   isDefault=true をセットすると他モデルの is_default を全部 false に揃える (排他)
 * DELETE /api/vrm/models/[id]
 *   - DB row 削除 + ファイル削除
 *   - もし current_model_id がこのモデルだったら、settings.current_model_id を NULL に
 *
 * 設計: docs/vrm-wardrobe.md (Phase 1)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { vrmModels, vrmSettings } from "@/db/schema";
import { eq, ne } from "drizzle-orm";
import { deleteVrmFiles } from "@/lib/vrm-storage";

export const dynamic = "force-dynamic";

function parseId(s: string): number | null {
  const n = parseInt(s, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const num = parseId(id);
  if (num === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const body = (await req.json().catch(() => null)) as
    | { name?: string; isDefault?: boolean; enabled?: boolean }
    | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const patch: { name?: string; isDefault?: boolean; enabled?: boolean } = {};
  if (typeof body.name === "string") {
    const t = body.name.trim();
    if (!t) return NextResponse.json({ error: "name cannot be empty" }, { status: 400 });
    patch.name = t;
  }
  if (typeof body.isDefault === "boolean") patch.isDefault = body.isDefault;
  if (typeof body.enabled === "boolean") patch.enabled = body.enabled;

  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ error: "no updatable fields" }, { status: 400 });
  }

  // isDefault=true は排他 (他を false に)
  if (patch.isDefault === true) {
    await db
      .update(vrmModels)
      .set({ isDefault: false })
      .where(ne(vrmModels.id, num));
  }

  const [updated] = await db
    .update(vrmModels)
    .set(patch)
    .where(eq(vrmModels.id, num))
    .returning();
  if (!updated) return NextResponse.json({ error: "not found" }, { status: 404 });

  return NextResponse.json({
    model: {
      id: Number(updated.id),
      name: updated.name,
      filename: updated.filename,
      thumbnail_filename: updated.thumbnailFilename,
      file_size_bytes: updated.fileSizeBytes,
      is_default: updated.isDefault,
      enabled: updated.enabled,
    },
  });
}

export async function DELETE(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const num = parseId(id);
  if (num === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });

  const [row] = await db.select().from(vrmModels).where(eq(vrmModels.id, num));
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  // current_model_id がこの行を指していたら settings 側を NULL に
  await db
    .update(vrmSettings)
    .set({ currentModelId: null, manualOverrideModelId: null, updatedAt: new Date() })
    .where(eq(vrmSettings.id, 1));

  await db.delete(vrmModels).where(eq(vrmModels.id, num));
  await deleteVrmFiles(row.filename, row.thumbnailFilename);

  return NextResponse.json({ ok: true });
}
