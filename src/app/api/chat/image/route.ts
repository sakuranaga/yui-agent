/**
 * GET /api/chat/image?session=<sid>&file=<uuid.webp>
 *
 * raw_messages.attachments に登録されている画像をディスクから配信する。
 * - session + filename 二重バリデーション (path traversal 対策)
 * - ファイルが期限切れ削除済み (pruneExpiredAttachments) なら 404
 * - キャッシュは 1 日 (ファイル名 immutable なので長くて OK)
 */
import { type NextRequest } from "next/server";
import { readImage } from "@/lib/chat-attachments";

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session");
  const file = req.nextUrl.searchParams.get("file");
  if (!session || !file) {
    return new Response("session and file required", { status: 400 });
  }
  const img = await readImage({ sessionId: session, filename: file });
  if (!img) {
    return new Response("not found", { status: 404 });
  }
  // Node Buffer は Web Response の BodyInit と直接互換が無いので、Uint8Array view を渡す。
  return new Response(new Uint8Array(img.data), {
    status: 200,
    headers: {
      "Content-Type": img.mediaType,
      "Content-Length": String(img.data.length),
      "Cache-Control": "private, max-age=86400, immutable",
    },
  });
}
