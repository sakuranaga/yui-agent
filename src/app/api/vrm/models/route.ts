/**
 * GET  /api/vrm/models                       list (id 順、enabled 含む全件)
 * POST /api/vrm/models  (multipart/form-data)
 *   file: VRM (.vrm) 必須
 *   name: 表示名 (省略時はファイル名から拡張子抜き)
 *   thumb: PNG (任意、無ければ thumbnail_filename=NULL — client が後で PUT する想定)
 *
 * 設計: docs/vrm-wardrobe.md (Phase 1)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { vrmModels } from "@/db/schema";
import { asc, eq } from "drizzle-orm";
import { saveVrmFile, saveThumbFile, deleteVrmFiles } from "@/lib/vrm-storage";

export const dynamic = "force-dynamic";

const MAX_VRM_BYTES = 60 * 1024 * 1024; // 60MB 上限 (VRoid Studio 標準出力は ~10-30MB)
const MAX_THUMB_BYTES = 2 * 1024 * 1024; // 2MB

/**
 * VRM = glb container (= glTF binary)。先頭 4 byte は ASCII "glTF" (0x67 0x6C 0x54 0x46)。
 * 次の 4 byte は version (uint32 LE)、続く 4 byte は file length。
 * これを確認することで「任意バイナリを .vrm と偽った upload」を弾く。
 */
function isLikelyVrm(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  return (
    buf[0] === 0x67 && // 'g'
    buf[1] === 0x6c && // 'l'
    buf[2] === 0x54 && // 'T'
    buf[3] === 0x46 // 'F'
  );
}

/** PNG signature: 89 50 4E 47 0D 0A 1A 0A */
function isLikelyPng(buf: Buffer): boolean {
  if (buf.length < 8) return false;
  return (
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

export async function GET() {
  const rows = await db.select().from(vrmModels).orderBy(asc(vrmModels.id));
  return NextResponse.json({
    models: rows.map((r) => ({
      id: Number(r.id),
      name: r.name,
      filename: r.filename,
      thumbnail_filename: r.thumbnailFilename,
      file_size_bytes: r.fileSizeBytes,
      is_default: r.isDefault,
      enabled: r.enabled,
      uploaded_at: r.uploadedAt.toISOString(),
    })),
  });
}

export async function POST(req: NextRequest) {
  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "multipart/form-data required" }, { status: 400 });
  }
  // body が proxyClientMaxBodySize (= next.config.ts、70MB) を超えると proxy 層で
  // 本文が切り詰められ、multipart parse がここで throw する。素の 500 にせず、
  // サイズ超過として 413 を返す (= 壊れた multipart でも同様だが実害の大半はサイズ超過)。
  let form: FormData;
  try {
    form = await req.formData();
  } catch (e) {
    console.warn(
      "[vrm/models] formData parse failed (likely body exceeded proxyClientMaxBodySize):",
      e instanceof Error ? e.message : String(e)
    );
    return NextResponse.json(
      {
        error: `ファイルが大きすぎてアップロードできませんでした (VRM は ${MAX_VRM_BYTES / 1024 / 1024}MB まで)`,
      },
      { status: 413 }
    );
  }
  const file = form.get("file");
  const name = (form.get("name") as string | null)?.trim();
  const thumb = form.get("thumb");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "ファイルが選択されていません" }, { status: 400 });
  }
  if (file.size > MAX_VRM_BYTES) {
    return NextResponse.json(
      {
        error: `VRM が大きすぎます (${(file.size / 1024 / 1024).toFixed(1)}MB / 上限 ${MAX_VRM_BYTES / 1024 / 1024}MB)`,
      },
      { status: 413 }
    );
  }
  if (thumb instanceof File && thumb.size > MAX_THUMB_BYTES) {
    return NextResponse.json(
      {
        error: `サムネイルが大きすぎます (${(thumb.size / 1024 / 1024).toFixed(1)}MB / 上限 ${MAX_THUMB_BYTES / 1024 / 1024}MB)`,
      },
      { status: 413 }
    );
  }

  // 1) ファイル本体を読み出して magic byte で実体確認 (= 拡張子だけ .vrm の任意バイナリを弾く)。
  //    DB 書き込みより前にやる: 検証失敗で __pending__ row が残るのを防ぐ。
  const vrmBuf = Buffer.from(await file.arrayBuffer());
  if (!isLikelyVrm(vrmBuf)) {
    return NextResponse.json(
      { error: "invalid VRM file (glTF binary signature 'glTF' not found in header)" },
      { status: 400 }
    );
  }

  let thumbBuf: Buffer | null = null;
  if (thumb instanceof File) {
    thumbBuf = Buffer.from(await thumb.arrayBuffer());
    if (!isLikelyPng(thumbBuf)) {
      return NextResponse.json(
        { error: "invalid thumbnail (PNG signature not found)" },
        { status: 400 }
      );
    }
  }

  // 2) DB に row を先に作って id を確保 → その id をファイル名に使う
  const displayName =
    name && name.length > 0
      ? name
      : (file.name.replace(/\.[^.]+$/, "") || "新しい秘書");
  const [inserted] = await db
    .insert(vrmModels)
    .values({
      name: displayName,
      filename: "__pending__", // 一旦 placeholder、下で update
      fileSizeBytes: file.size,
    })
    .returning({ id: vrmModels.id });

  const id = Number(inserted.id);

  // 3) ファイル書き出し + row 更新。途中で失敗したら row と書きかけファイルを cleanup
  //    (= __pending__ 状態の orphan row や保存途中の半端ファイルを残さない)。
  try {
    const { filename, size } = await saveVrmFile(id, vrmBuf);
    let thumbFilename: string | null = null;
    if (thumbBuf) {
      thumbFilename = await saveThumbFile(id, thumbBuf);
    }
    await db
      .update(vrmModels)
      .set({
        filename,
        fileSizeBytes: size,
        thumbnailFilename: thumbFilename,
      })
      .where(eq(vrmModels.id, id));

    return NextResponse.json({
      model: {
        id,
        name: displayName,
        filename,
        thumbnail_filename: thumbFilename,
        file_size_bytes: size,
        is_default: false,
        enabled: true,
      },
    });
  } catch (e) {
    // best-effort cleanup: ファイルがあれば削除 + DB row 削除
    try {
      await deleteVrmFiles(`${id}.vrm`, `${id}.thumb.png`);
    } catch (cleanupErr) {
      console.warn(`[vrm/models] cleanup files failed for id=${id}:`, cleanupErr);
    }
    try {
      await db.delete(vrmModels).where(eq(vrmModels.id, id));
    } catch (cleanupErr) {
      console.warn(`[vrm/models] cleanup row failed for id=${id}:`, cleanupErr);
    }
    const { clientError } = await import("@/lib/api-error");
    return clientError(req, e, {
      status: 500,
      message: "VRM のアップロードに失敗しました",
      context: "vrm/models POST",
    });
  }
}
