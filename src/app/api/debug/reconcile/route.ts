/**
 * デバッグ用: 指定 chunk_id をターゲットに reconcile を発火させる。
 * POST { chunkIds: number[] }
 *
 * デフォルトで 404 を返して無効化。明示的に有効化したい場合は
 * env `ENABLE_DEBUG_ROUTES=1` を立てる (Docker compose default は development
 * 設定なので、NODE_ENV だけで防ぐと配布物で通ってしまう)。
 */
import { reconcileNewChunks } from "@/lib/reconcile";

function notFound() {
  return new Response("Not Found", { status: 404 });
}

function debugEnabled(): boolean {
  return process.env.ENABLE_DEBUG_ROUTES === "1";
}

export async function POST(req: Request) {
  if (!debugEnabled()) return notFound();

  const body = await req.json().catch(() => ({}));
  const chunkIds = Array.isArray(body.chunkIds) ? body.chunkIds : [];
  if (chunkIds.length === 0) {
    return Response.json({ error: "chunkIds required" }, { status: 400 });
  }
  await reconcileNewChunks(chunkIds);
  return Response.json({ ok: true, processed: chunkIds.length });
}

export async function GET() {
  if (!debugEnabled()) return notFound();
  return Response.json({
    info: "POST { chunkIds: number[] } to trigger reconcile on those new chunks",
  });
}
