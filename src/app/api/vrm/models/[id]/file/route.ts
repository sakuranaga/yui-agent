/**
 * GET /api/vrm/models/[id]/file
 *   VRM ファイル本体を stream で返す。Three.js GLTFLoader から fetch される。
 *
 * 設計: docs/vrm-wardrobe.md (Phase 1)
 */
import { type NextRequest } from "next/server";
import { db } from "@/db/client";
import { vrmModels } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { vrmAbsPath } from "@/lib/vrm-storage";

export const dynamic = "force-dynamic";

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
  if (!row) return new Response("not found", { status: 404 });

  const abs = vrmAbsPath(row.filename);
  let size: number;
  let mtime: Date;
  try {
    const fst = await stat(abs);
    size = fst.size;
    mtime = fst.mtime;
  } catch {
    return new Response("file missing on disk", { status: 410 });
  }

  // 弱い ETag: size + mtime epoch (hex)。同一 id でファイル差し替えがあれば変わる。
  // VRM は数 MB あるので、If-None-Match の 304 短絡で帯域を大幅節約できる。
  const etag = `W/"${size.toString(16)}-${mtime.getTime().toString(16)}"`;
  const cacheHeaders: HeadersInit = {
    "ETag": etag,
    "Last-Modified": mtime.toUTCString(),
    "Cache-Control": "private, max-age=300, must-revalidate",
  };
  if (req.headers.get("if-none-match") === etag) {
    return new Response(null, { status: 304, headers: cacheHeaders });
  }

  // Web Streams API でファイルを stream
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
      "Content-Type": "model/gltf-binary",
      "Content-Length": String(size),
    },
  });
}
