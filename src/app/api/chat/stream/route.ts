/**
 * Server-Sent Events endpoint per session.
 *
 *   GET /api/chat/stream?session=<uuid>
 *
 * クライアント (EventSource) はこれに接続して、bg job が完了するたびに
 * Yui の追加メッセージを push 受信する。
 */
import {
  subscribeSession,
  type ServerEvent,
} from "@/lib/jobs/events";

// SSE はストリーミング応答なので Node runtime にしておく
export const runtime = "nodejs";
// 動的、キャッシュしない
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000; // 30sec proxy timeout 回避

export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("session");
  if (!sessionId) {
    return new Response("session param required", { status: 400 });
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let closed = false;

      const send = (event: ServerEvent) => {
        if (closed) return;
        try {
          // SSE format: "data: <json>\n\n" with event name optional
          const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          // controller already closed (client disconnected)
          closed = true;
        }
      };

      // 開通の合図 (clientの onopen が発火する)
      controller.enqueue(
        encoder.encode(
          `event: ready\ndata: ${JSON.stringify({ sessionId })}\n\n`
        )
      );

      const unsubscribe = subscribeSession(sessionId, send);

      // heartbeat (proxy / browser タイムアウト回避)
      const heartbeat = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"));
        } catch {
          closed = true;
        }
      }, HEARTBEAT_MS);

      // クライアント disconnect 時のクリーンアップ
      const cleanup = () => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };

      req.signal.addEventListener("abort", cleanup);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // nginx 等の buffer 抑止
    },
  });
}
