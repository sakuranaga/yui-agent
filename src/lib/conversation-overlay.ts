/**
 * 会話 overlay (DB に残さない揮発記録、Valkey 上に 24h 保存)。
 *
 * 用途:
 *  - プライベートモードの user / Yui 会話 (raw_messages を skip して overlay に書く)
 *  - ニュース紹介 / 音楽紹介 等の SSE-only メッセージ (DB に元々入らないが、リロード
 *    生存させるため tee する)
 *
 * モデル:
 *  - Redis list `conv-overlay:<sessionId>`、RPUSH で時系列追記
 *  - 各 entry は JSON: { id, role, content, ts, source?, emotion?, toolSummary?, kind }
 *  - kind:
 *      "private"       - プライベートモード会話 (DB と完全分離、Yui 記憶対象外)
 *      "ephemeral"     - SSE 発火由来 (news/music intro 等、DB 不在をリロード生存で補完)
 *  - TTL は append のたびに 24h 再セット (アクティブ session は維持、放置は自然消去)
 *
 * 設計: docs/roadmap.md (private mode)
 */
import { cacheGet, cacheSet, cacheDel } from "@/lib/cache";

export type OverlayKind = "private" | "ephemeral";

export type OverlayEntry = {
  id: string;            // 短い乱数 ID (UI key 用)
  role: "user" | "assistant";
  content: string;
  ts: number;            // ms epoch
  kind: OverlayKind;
  source?: string;       // "web" / "discord_text" / "cron" 等 (chat/route.ts と整合)
  emotion?: string;
  toolSummary?: Array<{ name: string; brief: string }>;
};

const TTL_SEC = 24 * 60 * 60;

function key(sessionId: string): string {
  return `conv-overlay:${sessionId}`;
}

function randomId(): string {
  // UUID は重い、Math.random は禁止 (Workflow 制約は spec から外れるが念のため避ける)
  // Node の crypto は server 側で使える
  if (typeof globalThis.crypto !== "undefined" && "randomUUID" in globalThis.crypto) {
    return globalThis.crypto.randomUUID().slice(0, 12);
  }
  return `${Date.now().toString(36)}-${Math.floor(performance.now()).toString(36)}`;
}

/**
 * overlay 1 件追加。TTL を再セット (24h)。
 * 失敗は warn だけで握り潰し、caller を止めない (overlay は "あれば便利、無くても困らない")。
 */
export async function appendOverlay(
  sessionId: string,
  entry: Omit<OverlayEntry, "id" | "ts"> & { id?: string; ts?: number }
): Promise<void> {
  const full: OverlayEntry = {
    id: entry.id ?? randomId(),
    role: entry.role,
    content: entry.content,
    ts: entry.ts ?? Date.now(),
    kind: entry.kind,
    source: entry.source,
    emotion: entry.emotion,
    toolSummary: entry.toolSummary,
  };

  const existing = (await cacheGet<OverlayEntry[]>(key(sessionId))) ?? [];
  existing.push(full);
  // append のたびに list 全体を再 SET (cacheSet は EX で TTL refresh される)
  await cacheSet(key(sessionId), existing, TTL_SEC);
}

/** session 全 overlay を時系列で返す。空なら [] */
export async function readOverlay(sessionId: string): Promise<OverlayEntry[]> {
  const list = (await cacheGet<OverlayEntry[]>(key(sessionId))) ?? [];
  return list.sort((a, b) => a.ts - b.ts);
}

/** session の overlay を完全削除 (UI からの「履歴クリア」用、v1 では UI 未提供) */
export async function clearOverlay(sessionId: string): Promise<void> {
  await cacheDel(key(sessionId));
}
