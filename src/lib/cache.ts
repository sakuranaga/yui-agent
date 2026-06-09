/**
 * Valkey (Redis 互換) ベースのキャッシュ層。
 *
 * - 接続: docker-compose の `valkey` service (internal only)。env VALKEY_URL で override 可。
 * - シリアライズ: JSON。caller が任意の型を string 化して保存/復元。
 * - lazyConnect: import で直接接続せず最初の呼び出しで lazy connect (build / SSR で
 *   接続エラーが起きないように)。
 * - 失敗は安全側に倒す: get/set/del いずれも例外を握り潰してログ警告のみ。
 *   キャッシュは「あれば速い、無ければ元処理にフォールバック」が大原則。
 *
 * 使い方:
 *   import { cacheGet, cacheSet } from "@/lib/cache";
 *
 *   await cacheSet("foo", { bar: 1 }, 300);
 *   const v = await cacheGet<{ bar: number }>("foo");
 *
 * 設計: docs/roadmap.md §7.x (Valkey 導入)
 */
import Redis from "ioredis";

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://valkey:6379";

let client: Redis | null = null;
// 初回接続の promise。lazyConnect=true + enableOfflineQueue=false の組み合わせで、
// connect 完了前の get/set が "Stream isn't writeable" で即失敗していたのを防ぐため、
// 各 cache 操作の前に await readyPromise する。
let readyPromise: Promise<boolean> | null = null;

function getClient(): Redis {
  if (client) return client;
  client = new Redis(VALKEY_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 2,
    // Redis 互換の Valkey なので default OK
    enableOfflineQueue: false, // 接続不可なら即 error → caller が fallback
  });
  client.on("error", (err) => {
    // 接続失敗ログは 1 回だけ
    console.warn("[cache] valkey error:", err.message);
  });
  // connect を 1 度だけ起動して promise を保持。成功 → true、失敗 → false。
  // 以降 ensureReady() が false を返した呼び出し元は cache 操作を skip して
  // safe-fallback (= cache 無しと同じ挙動) になる。
  readyPromise = client
    .connect()
    .then(() => true)
    .catch((err) => {
      console.warn("[cache] valkey connect failed:", err instanceof Error ? err.message : err);
      return false;
    });
  return client;
}

/** 初回 connect 完了を保証する。false 返り = 接続不可 (caller は cache を諦める)。 */
async function ensureReady(): Promise<boolean> {
  getClient();
  return readyPromise ?? Promise.resolve(false);
}

/** namespace 付き key (将来 multi-tenant 化したい時用、今は固定 prefix のみ) */
function k(key: string): string {
  return `vroid:${key}`;
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  if (!(await ensureReady())) return null;
  try {
    const raw = await getClient().get(k(key));
    if (raw === null) return null;
    return JSON.parse(raw) as T;
  } catch (e) {
    console.warn(`[cache] get(${key}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSec: number): Promise<void> {
  if (!(await ensureReady())) return;
  try {
    const serialized = JSON.stringify(value);
    if (ttlSec > 0) {
      await getClient().set(k(key), serialized, "EX", ttlSec);
    } else {
      await getClient().set(k(key), serialized);
    }
  } catch (e) {
    console.warn(`[cache] set(${key}) failed:`, e instanceof Error ? e.message : e);
  }
}

export async function cacheDel(...keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  if (!(await ensureReady())) return;
  try {
    await getClient().del(...keys.map(k));
  } catch (e) {
    console.warn(`[cache] del failed:`, e instanceof Error ? e.message : e);
  }
}

/**
 * pattern (例: "ai:settings:*") に一致する key を一括削除。
 * SCAN 経由なので大量 key でもブロックしない。
 */
export async function cacheDelPattern(pattern: string): Promise<number> {
  if (!(await ensureReady())) return 0;
  const cli = getClient();
  let removed = 0;
  try {
    const stream = cli.scanStream({ match: k(pattern), count: 100 });
    const batches: string[][] = [];
    for await (const chunk of stream as AsyncIterable<string[]>) {
      if (chunk.length > 0) batches.push(chunk);
    }
    for (const batch of batches) {
      await cli.del(...batch);
      removed += batch.length;
    }
  } catch (e) {
    console.warn(`[cache] delPattern(${pattern}) failed:`, e instanceof Error ? e.message : e);
  }
  return removed;
}
