/**
 * 最小 SSE クライアント。Node 18+ の fetch + ReadableStream で動く。
 * EventSource (Web 標準) は Node に無いので自前。
 *
 * 接続が切れたら exponential backoff で自動再接続。
 */

export type SseEvent = {
  /** event: 行の値。サーバは "ready", "yui_message", "timer_fired" 等を流す */
  name: string;
  /** data: 行の JSON。pushToSession の event object そのまま */
  data: unknown;
};

export type SseOpts = {
  url: string;
  onEvent: (e: SseEvent) => void;
  /** 接続エラー / 切断のログ用 */
  onError?: (err: unknown) => void;
  /** 再接続停止用 (true を返したら抜ける) */
  shouldStop?: () => boolean;
  /** 追加ヘッダ (= 認証 X-Internal-Auth 等) */
  headers?: Record<string, string>;
};

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 30_000;

export async function runSseLoop(opts: SseOpts): Promise<void> {
  let backoff = MIN_BACKOFF_MS;
  while (true) {
    if (opts.shouldStop?.()) return;
    try {
      await connectOnce(opts);
      // 正常切断 (サーバ close) → backoff リセット
      backoff = MIN_BACKOFF_MS;
    } catch (e) {
      opts.onError?.(e);
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
    if (opts.shouldStop?.()) return;
    await sleep(backoff);
  }
}

async function connectOnce(opts: SseOpts): Promise<void> {
  const res = await fetch(opts.url, {
    headers: { Accept: "text/event-stream", ...(opts.headers ?? {}) },
  });
  if (!res.ok || !res.body) {
    throw new Error(`SSE connect failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    if (opts.shouldStop?.()) {
      void reader.cancel().catch(() => {});
      return;
    }
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    // SSE のレコード境界は空行 (\n\n)
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) >= 0) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const parsed = parseEventBlock(raw);
      if (parsed) opts.onEvent(parsed);
    }
  }
}

function parseEventBlock(block: string): SseEvent | null {
  let name = "message";
  let dataLine = "";
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) continue; // heartbeat / comment
    if (line.startsWith("event:")) {
      name = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLine += line.slice(5).trim();
    }
  }
  if (!dataLine) return null;
  try {
    return { name, data: JSON.parse(dataLine) };
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
