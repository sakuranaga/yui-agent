/**
 * GET /api/sleep/bgm/[id]/file
 *   user upload された BGM 本体を stream で返す (= data/sleep-bgm/{id}.mp3)。
 *
 * is_uploaded=false (= legacy preset) の row は静的 public 配信なのでここに来ない。
 * 念のため row.is_uploaded を確認して、preset を間違って request された場合は 410。
 */
import { type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepBgm } from "@/db/schema";
import { eq } from "drizzle-orm";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { uploadedBgmAbsPath } from "@/lib/sleep-bgm-storage";

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

  const [row] = await db.select().from(sleepBgm).where(eq(sleepBgm.id, num));
  if (!row) return new Response("not found", { status: 404 });
  if (!row.isUploaded) {
    return new Response(
      "this BGM is a legacy preset; serve via /sleep-bgm/<filename>",
      { status: 410 }
    );
  }

  const abs = uploadedBgmAbsPath(row.filename);
  let size: number;
  let mtime: Date;
  try {
    const fst = await stat(abs);
    size = fst.size;
    mtime = fst.mtime;
  } catch {
    return new Response("file missing on disk", { status: 410 });
  }

  // 弱い ETag。BGM ファイルは id に紐付き、ほぼ不変なので 24h cache + ETag で十分。
  const etag = `W/"${size.toString(16)}-${mtime.getTime().toString(16)}"`;
  const cacheHeaders: HeadersInit = {
    "ETag": etag,
    "Last-Modified": mtime.toUTCString(),
    "Cache-Control": "public, max-age=86400, must-revalidate",
    "Accept-Ranges": "bytes",
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
      "Content-Type": "audio/mpeg",
      "Content-Length": String(size),
    },
  });
}
