/**
 * 外部連携 (AI 以外) の key/value 設定。
 *
 * - Google Maps API key (= 道案内 tool が使う)
 * - 将来: Mapbox / Stripe / 他 API key 等
 *
 * 取得は DB → env fallback の順。30s キャッシュ (Valkey)。
 */
import { db } from "@/db/client";
import { integrationSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { cacheGet, cacheSet, cacheDel } from "@/lib/cache";

export type IntegrationKey =
  | "google_maps_api_key"
  | "spotify_client_id"
  | "spotify_client_secret";

/** どの key が secret 扱いか (マスク表示 + "***" スキップ判定) */
export const INTEGRATION_SECRET_KEYS: ReadonlySet<IntegrationKey> = new Set<IntegrationKey>([
  "google_maps_api_key",
  "spotify_client_id",
  "spotify_client_secret",
]);

/** env fallback の対応 */
const ENV_FALLBACK: Record<IntegrationKey, string | null> = {
  google_maps_api_key: "GOOGLE_MAPS_API_KEY",
  spotify_client_id: "SPOTIFY_CLIENT_ID",
  spotify_client_secret: "SPOTIFY_CLIENT_SECRET",
};

const CACHE_KEY = "integration-settings:all";
const CACHE_TTL_SEC = 30;

async function loadAllFromDb(): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  try {
    const rows = await db.select().from(integrationSettings);
    for (const r of rows) out[r.key] = r.value;
  } catch (e) {
    console.warn("[integration-settings] DB load failed:", e);
  }
  return out;
}

async function ensureCache(): Promise<Map<string, string>> {
  const hit = await cacheGet<Record<string, string>>(CACHE_KEY);
  if (hit) return new Map(Object.entries(hit));
  const fresh = await loadAllFromDb();
  await cacheSet(CACHE_KEY, fresh, CACHE_TTL_SEC);
  return new Map(Object.entries(fresh));
}

/** 単一 key を取得 (DB → env)。未設定なら null */
export async function getSetting(key: IntegrationKey): Promise<string | null> {
  const cache = await ensureCache();
  const dbValue = cache.get(key);
  if (dbValue && dbValue.length > 0) return dbValue;
  const envName = ENV_FALLBACK[key];
  if (envName) {
    const envValue = process.env[envName];
    if (envValue && envValue.length > 0) return envValue;
  }
  return null;
}

/** 全 key 取得 (UI 用、secret はマスク済) */
export async function listSettings(): Promise<
  Array<{ key: IntegrationKey; value: string | null; masked: boolean; source: "db" | "env" | null }>
> {
  const cache = await ensureCache();
  const keys: IntegrationKey[] = [
    "google_maps_api_key",
    "spotify_client_id",
    "spotify_client_secret",
  ];
  return keys.map((k) => {
    const dbValue = cache.get(k);
    const envName = ENV_FALLBACK[k];
    const envValue = envName ? process.env[envName] : undefined;
    const raw = dbValue && dbValue.length > 0 ? dbValue : (envValue && envValue.length > 0 ? envValue : null);
    const source: "db" | "env" | null = dbValue && dbValue.length > 0 ? "db" : envValue ? "env" : null;
    const isSecret = INTEGRATION_SECRET_KEYS.has(k);
    return {
      key: k,
      value: raw === null ? null : isSecret ? maskSecret(raw) : raw,
      masked: isSecret,
      source,
    };
  });
}

function maskSecret(s: string): string {
  if (s.length <= 8) return "***";
  return s.slice(0, 4) + "..." + s.slice(-4);
}

/** upsert (= 「***」が来た時は更新せず既存維持) */
export async function setSetting(key: IntegrationKey, value: string): Promise<void> {
  // ***, *** マスク値 は更新しない (= UI のマスク表示をそのまま PUT された場合)
  if (value === "***" || /^.{4}\.\.\..{4}$/.test(value)) return;
  if (value.length === 0) {
    // 空文字 = 削除
    await db.delete(integrationSettings).where(eq(integrationSettings.key, key));
  } else {
    await db
      .insert(integrationSettings)
      .values({ key, value, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: integrationSettings.key,
        set: { value, updatedAt: new Date() },
      });
  }
  await cacheDel(CACHE_KEY);
}

/** 道案内用 helper (= 呼出側でこれを直接使う) */
export async function getGoogleMapsApiKey(): Promise<string | null> {
  return getSetting("google_maps_api_key");
}

/**
 * Spotify OAuth client 資格情報。両方揃っていなければ null。
 * src/lib/spotify.ts が token 交換 / refresh 時に参照する。
 */
export async function getSpotifyClientCredentials(): Promise<
  { id: string; secret: string } | null
> {
  const [id, secret] = await Promise.all([
    getSetting("spotify_client_id"),
    getSetting("spotify_client_secret"),
  ]);
  if (!id || !secret) return null;
  return { id, secret };
}
