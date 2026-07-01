/**
 * 位置情報 (緯度経度) のサーバ側ストア。
 * Frontend (navigator.geolocation) → POST /api/location → ここに保存。
 * weather / 他 environment provider が読みに来る。
 *
 * 単一ユーザー前提なので global 一箇所、hot reload 越え用に globalThis。
 * 再起動越えのため DB (user_location シングルトン) にも永続化する。
 * 周期処理 (日記生成等) がコンテナ再起動直後に走るとフロントの再 push より
 * 先に発火して天気情報が抜けるため。
 *
 * プライバシー方針:
 *   - lat/lon そのものは LLM に渡さない (env block にも入れない)
 *   - reverse-geocode した「都市・区レベル」の地域名のみを env block に入れる
 *   - 生 lat/lon は WeatherKit や web_search の lat/lon パラメータでのみ使用
 */
import { db } from "@/db/client";
import { userLocation } from "@/db/schema";
import { eq } from "drizzle-orm";

export type Location = {
  lat: number;
  lon: number;
  accuracy?: number;
  updatedAt: number;
  /** Reverse-geocode した人間可読の地域名 (例: "東京都新宿区") */
  placeLabel?: string;
  /** 上記の geocoding 完了時刻 (ms) */
  placeLabelAt?: number;
};

declare global {
  var __vroidLocation: Location | null | undefined;
  var __vroidLocationLoaded: boolean | undefined;
}

const GEOCODE_TTL_MS = 60 * 60 * 1000; // 1 時間キャッシュ
const GEOCODE_MIN_MOVE_M = 200;        // 200m 以上動いたら再 geocode

export function setLocation(loc: Location): void {
  const prev = globalThis.__vroidLocation ?? null;

  // 前回の placeLabel を保持しつつ更新 (まだ geocode してない時用)
  const next: Location = {
    ...loc,
    placeLabel: loc.placeLabel ?? prev?.placeLabel,
    placeLabelAt: loc.placeLabelAt ?? prev?.placeLabelAt,
  };
  globalThis.__vroidLocation = next;
  globalThis.__vroidLocationLoaded = true;

  // 必要なら非同期で reverse-geocode
  const needGeocode =
    !prev?.placeLabel ||
    !prev?.placeLabelAt ||
    Date.now() - prev.placeLabelAt > GEOCODE_TTL_MS ||
    haversine(prev.lat, prev.lon, loc.lat, loc.lon) > GEOCODE_MIN_MOVE_M;

  if (needGeocode) {
    void reverseGeocode(loc.lat, loc.lon)
      .then((label) => {
        if (!label) return;
        const cur = globalThis.__vroidLocation;
        if (!cur) return;
        const withLabel: Location = {
          ...cur,
          placeLabel: label,
          placeLabelAt: Date.now(),
        };
        globalThis.__vroidLocation = withLabel;
        void persistLocation(withLabel);
      })
      .catch((e) => console.warn("[location] reverse-geocode failed:", e));
  }

  // DB に永続化 (再起動越え)
  void persistLocation(next);
}

export function getLocation(): Location | null {
  return globalThis.__vroidLocation ?? null;
}

/** env block / Yui に見せる用の地域名だけ。lat/lon は出さない。 */
export function getPlaceLabel(): string | null {
  return globalThis.__vroidLocation?.placeLabel ?? null;
}

/**
 * 起動時に 1 度だけ DB から読み込んで in-memory にロード。
 * - setLocation が一度でも呼ばれていれば skip (in-memory が SoT)
 * - 重複ロードを避けるため __vroidLocationLoaded フラグで dedup
 */
export async function loadLocationFromDb(): Promise<void> {
  if (globalThis.__vroidLocationLoaded) return;
  try {
    const [row] = await db
      .select()
      .from(userLocation)
      .where(eq(userLocation.id, 1))
      .limit(1);
    // DB 応答が返った時点で loaded 確定 (row の有無に関わらず)。
    // ※ フラグを DB 呼び出し前に立てると、起動直後の DB 一時失敗で永久 no-op になり
    //    後続の保険 (safeWeather / /api/weather) も再試行できなくなるため、成功後に立てる。
    globalThis.__vroidLocationLoaded = true;
    if (!row) return;
    if (globalThis.__vroidLocation) return; // 競合: 先に setLocation された
    globalThis.__vroidLocation = {
      lat: row.lat,
      lon: row.lon,
      accuracy: row.accuracy ?? undefined,
      updatedAt: row.updatedAt.getTime(),
      placeLabel: row.placeLabel ?? undefined,
      placeLabelAt: row.placeLabelAt?.getTime(),
    };
    console.log(
      `[location] restored from DB: ${row.placeLabel ?? "(no label)"} @${row.lat.toFixed(3)},${row.lon.toFixed(3)}`
    );
  } catch (e) {
    console.warn("[location] DB restore failed:", e);
  }
}

async function persistLocation(loc: Location): Promise<void> {
  try {
    await db
      .insert(userLocation)
      .values({
        id: 1,
        lat: loc.lat,
        lon: loc.lon,
        accuracy: loc.accuracy,
        placeLabel: loc.placeLabel,
        placeLabelAt: loc.placeLabelAt ? new Date(loc.placeLabelAt) : null,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: userLocation.id,
        set: {
          lat: loc.lat,
          lon: loc.lon,
          accuracy: loc.accuracy,
          placeLabel: loc.placeLabel,
          placeLabelAt: loc.placeLabelAt ? new Date(loc.placeLabelAt) : null,
          updatedAt: new Date(),
        },
      });
  } catch (e) {
    console.warn("[location] persist failed:", e);
  }
}

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * Nominatim (OpenStreetMap) で lat/lon → "東京都新宿区" 等を取得。
 * - 無料、API key 不要、User-Agent 必須、1 req/秒上限 (個人用ならまず問題ない)
 * - 日本国内なら state=都道府県, city/town=市区町村, suburb=町丁
 */
async function reverseGeocode(lat: number, lon: number): Promise<string | null> {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lon}&zoom=14&format=json&accept-language=ja`;
  try {
    // eslint-disable-next-line no-restricted-syntax -- Nominatim 公式 endpoint 固定 (reverse geocoding)
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Yui-personal-assistant/0.1 (self-hosted, single user)",
      },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as {
      address?: {
        country?: string;
        country_code?: string;
        state?: string;
        province?: string;
        city?: string;
        town?: string;
        village?: string;
        suburb?: string;
        neighbourhood?: string;
        quarter?: string;
        county?: string;
      };
    };
    const a = data.address ?? {};
    const isJP = a.country_code === "jp";

    if (isJP) {
      // 日本: 県は省略可 (Nominatim が返さないケースもある)、市区町村 + (任意) 街区
      const city = a.city ?? a.town ?? a.village ?? a.county ?? "";
      const quarter = a.quarter ?? a.suburb ?? "";
      const parts = [city, quarter].filter(Boolean);
      // neighbourhood (歌舞伎町一丁目 のような町丁) は narrow すぎるので省く
      return parts.length > 0 ? parts.join(" ") : null;
    }

    // 海外: 国 / 州 / 市
    const region = a.state ?? a.province ?? "";
    const city = a.city ?? a.town ?? a.village ?? "";
    const parts = [a.country, region, city].filter(Boolean);
    return parts.length > 0 ? parts.join(" ") : null;
  } catch {
    return null;
  }
}
