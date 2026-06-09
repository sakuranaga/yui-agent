/**
 * GET /api/vrm/models/[id]/thumb     PNG (saved 時 client 側で render → upload した結果)
 * PUT /api/vrm/models/[id]/thumb     multipart で thumb 差し替え (手動 override)
 *
 * 設計: docs/vrm-wardrobe.md (Phase 1)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { vrmModels } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { vrmAbsPath, saveThumbFile } from "@/lib/vrm-storage";

export const dynamic = "force-dynamic";

const MAX_THUMB_BYTES = 2 * 1024 * 1024;

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const num = parseInt(id, 10);
  if (!Number.isFinite(num) || num <= 0) {
    return new Response("invalid id", { status: 400 });
  }

  const [row] = await db.select().from(vrmModels).where(eq(vrmModels.id, num));
  if (!row || !row.thumbnailFilename) {
    return new Response("no thumb", { status: 404 });
  }

  const abs = vrmAbsPath(row.thumbnailFilename);
  let size: number;
  let mtime: Date;
  try {
    const fst = await stat(abs);
    size = fst.size;
    mtime = fst.mtime;
  } catch {
    return new Response("file missing on disk", { status: 410 });
  }

  // 弱い ETag (size + mtime hex)。PUT で thumb 差し替えがあれば mtime 変化 → cache 破棄。
  const etag = `W/"${size.toString(16)}-${mtime.getTime().toString(16)}"`;
  const cacheHeaders: HeadersInit = {
    "ETag": etag,
    "Last-Modified": mtime.toUTCString(),
    "Cache-Control": "private, max-age=300, must-revalidate",
  };
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }

  const nodeStream = createReadStream(abs);
  const webStream = new ReadableStream({
    start(controller) {
      nodeStream.on("data", (chunk) => controller.enqueue(chunk));
      nodeStream.on("end", () => controller.close());
      nodeStream.on("error", (err) => controller.error(err));
    },
    cancel() {
      nodeStream.destroy();
    },
  });

  return new Response(webStream, {
    status: 200,
    headers: {
      ...cacheHeaders,
      "Content-Type": "image/png",
      "Content-Length": String(size),
    },
  });
}

export async function PUT(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const num = parseInt(id, 10);
  if (!Number.isFinite(num) || num <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const ct = req.headers.get("content-type") ?? "";
  if (!ct.includes("multipart/form-data")) {
    return NextResponse.json({ error: "multipart/form-data required" }, { status: 400 });
  }
  const form = await req.formData();
  const thumb = form.get("thumb");
  if (!(thumb instanceof File)) {
    return NextResponse.json({ error: "thumb required" }, { status: 400 });
  }
  if (thumb.size > MAX_THUMB_BYTES) {
    return NextResponse.json(
      { error: `thumb too large (${thumb.size} > ${MAX_THUMB_BYTES})` },
      { status: 413 }
    );
  }

  const [row] = await db.select().from(vrmModels).where(eq(vrmModels.id, num));
  if (!row) return NextResponse.json({ error: "not found" }, { status: 404 });

  const buf = Buffer.from(await thumb.arrayBuffer());
  const filename = await saveThumbFile(num, buf);
  await db
    .update(vrmModels)
    .set({ thumbnailFilename: filename })
    .where(eq(vrmModels.id, num));

  return NextResponse.json({ thumbnail_filename: filename });
}
