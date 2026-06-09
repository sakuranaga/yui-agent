/**
 * Google Routes API (新) ラッパー。
 *
 * 旧 Directions API は server 側からの transit 取得が機能しないため、
 * 新しい Routes API (https://routes.googleapis.com) を使う。
 *
 * - 3 モード (transit / driving / walking) を並列取得
 * - API key は integration_settings 経由 (= 連携タブで保存)
 * - 5 min Valkey キャッシュ
 *
 * 設計: 道案内エージェント (Yui tool `get_route` の backend)
 */
import { getGoogleMapsApiKey } from "@/lib/integration-settings";
import { cacheGet, cacheSet } from "@/lib/cache";
import { getLocation } from "@/lib/location";

const ROUTES_URL = "https://routes.googleapis.com/directions/v2:computeRoutes";

export type RouteMode = "transit" | "driving" | "walking";

export type RouteSummary = {
  mode: RouteMode;
  ok: boolean;
  error?: string;
  distanceMeters?: number;
  durationSeconds?: number;
  // transit のみ (= 将来、駅すぱあと等で structured データ取れた時に埋まる)
  transitFareYen?: number;
  transitTransfers?: number;
  transitSteps?: Array<{
    line: string;
    fromStation: string;
    toStation: string;
    departureTime?: string;
    arrivalTime?: string;
    numStops?: number;
  }>;
  /**
   * Google Maps への deep link (= 主に transit fallback 用)。
   * 「クリックで実際の経路を Maps で確認できる」UI 誘導用。
   * 駅すぱあと スタンダードが有効になったら transit はこれを使わず構造化データで返す。
   */
  fallbackUrl?: string;
  // driving のみ
  hasTraffic?: boolean;
  polyline?: string;
};

export type RouteRequest = {
  destination: string;
  from?: string;
  modes?: RouteMode[];
};

export type RouteResponse = {
  origin: string;
  destination: string;
  results: RouteSummary[];
  generatedAt: string;
};

export async function getRoute(req: RouteRequest): Promise<RouteResponse> {
  const apiKey = await getGoogleMapsApiKey();
  if (!apiKey) {
    return {
      origin: req.from ?? "(未設定)",
      destination: req.destination,
      results: (req.modes ?? ["transit", "driving", "walking"]).map((m) => ({
        mode: m,
        ok: false,
        error: "Google Maps API key 未設定 (設定 > 連携 タブから登録してください)",
      })),
      generatedAt: new Date().toISOString(),
    };
  }

  let origin = req.from;
  if (!origin) {
    const loc = getLocation();
    if (loc) origin = `${loc.lat},${loc.lon}`;
    else origin = "現在地";
  }

  const modes = req.modes ?? ["transit", "driving", "walking"];

  const cacheKey = `route:${origin}:${req.destination}:${modes.join(",")}:${Math.floor(Date.now() / (5 * 60_000))}`;
  const cached = await cacheGet<RouteResponse>(cacheKey);
  if (cached) return cached;

  const results = await Promise.all(
    modes.map(async (mode) => {
      // transit は Google Maps Platform (REST / JS SDK) が JP データを提供してないため
      // 直接の API 呼出は無駄 (= 必ず ZERO_RESULTS)。fallback URL だけ返す。
      // 駅すぱあと スタンダードが有効になったら transit はそちらで上書き。
      if (mode === "transit") {
        return {
          mode,
          ok: true,
          fallbackUrl: buildMapsTransitUrl(origin!, req.destination),
        } as RouteSummary;
      }
      return fetchOneMode(origin!, req.destination, mode, apiKey);
    })
  );

  const out: RouteResponse = {
    origin,
    destination: req.destination,
    results,
    generatedAt: new Date().toISOString(),
  };
  await cacheSet(cacheKey, out, 300);
  return out;
}

// ───── Routes API 呼出 ─────

function makeWaypoint(s: string): Record<string, unknown> {
  // lat,lng 形式なら location.latLng として渡す、それ以外は address (文字列)
  const m = s.match(/^(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)$/);
  if (m) {
    return {
      location: {
        latLng: { latitude: parseFloat(m[1]), longitude: parseFloat(m[2]) },
      },
    };
  }
  return { address: s };
}

function travelMode(mode: RouteMode): string {
  if (mode === "transit") return "TRANSIT";
  if (mode === "driving") return "DRIVE";
  return "WALK";
}

function fieldMask(mode: RouteMode): string {
  const base = [
    "routes.duration",
    "routes.distanceMeters",
    "routes.polyline.encodedPolyline",
  ];
  if (mode === "transit") {
    base.push(
      "routes.legs.steps.travelMode",
      "routes.legs.steps.transitDetails",
    );
  }
  // driving の混雑時間は staticDuration / duration を両方取れば差分が混雑分
  if (mode === "driving") {
    base.push("routes.staticDuration");
  }
  return base.join(",");
}

async function fetchOneMode(
  origin: string,
  destination: string,
  mode: RouteMode,
  apiKey: string
): Promise<RouteSummary> {
  try {
    const body: Record<string, unknown> = {
      origin: makeWaypoint(origin),
      destination: makeWaypoint(destination),
      travelMode: travelMode(mode),
      languageCode: "ja",
      regionCode: "JP",
      units: "METRIC",
    };

    // Routes API は departureTime に厳密未来時刻を要求するので 60 秒先に
    const futureTime = new Date(Date.now() + 60_000).toISOString();
    if (mode === "driving") {
      body.routingPreference = "TRAFFIC_AWARE";
      body.departureTime = futureTime;
    }
    if (mode === "transit") {
      body.transitPreferences = {
        allowedTravelModes: ["TRAIN", "SUBWAY", "BUS", "RAIL", "LIGHT_RAIL"],
        routingPreference: "FEWER_TRANSFERS",
      };
      body.departureTime = futureTime;
    }

    // eslint-disable-next-line no-restricted-syntax -- Google Maps Routes API 公式 endpoint 固定
    const res = await fetch(ROUTES_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask(mode),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      const text = await res.text();
      return { mode, ok: false, error: `HTTP ${res.status}: ${text.slice(0, 200)}` };
    }
    const data = (await res.json()) as RoutesApiResp;
    const route = data.routes?.[0];
    if (!route) return { mode, ok: false, error: "no route (ZERO_RESULTS)" };
    return parseRoute(mode, route);
  } catch (e) {
    return { mode, ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ───── レスポンス解析 ─────

type RoutesApiResp = {
  routes?: Array<RoutesApiRoute>;
};
type RoutesApiRoute = {
  duration?: string;          // "1800s"
  staticDuration?: string;    // driving の混雑無し時間
  distanceMeters?: number;
  polyline?: { encodedPolyline?: string };
  legs?: Array<{
    steps?: Array<RoutesApiStep>;
  }>;
};
type RoutesApiStep = {
  travelMode?: string;        // "TRANSIT" | "WALK" | "DRIVE"
  transitDetails?: {
    stopDetails?: {
      arrivalStop?: { name?: string };
      departureStop?: { name?: string };
      arrivalTime?: string;   // ISO
      departureTime?: string;
    };
    localizedValues?: {
      arrivalTime?: { time?: { text?: string } };
      departureTime?: { time?: { text?: string } };
    };
    transitLine?: {
      name?: string;
      nameShort?: string;
      vehicle?: { name?: { text?: string }; type?: string };
    };
    stopCount?: number;
  };
};

function parseDurationSec(s?: string): number | undefined {
  if (!s) return undefined;
  const m = s.match(/^(\d+(?:\.\d+)?)s$/);
  if (!m) return undefined;
  return Math.round(parseFloat(m[1]));
}

function parseRoute(mode: RouteMode, route: RoutesApiRoute): RouteSummary {
  const out: RouteSummary = {
    mode,
    ok: true,
    distanceMeters: route.distanceMeters,
    durationSeconds: parseDurationSec(route.duration),
    polyline: route.polyline?.encodedPolyline,
  };

  if (mode === "driving") {
    const traffic = parseDurationSec(route.duration);
    const noTraffic = parseDurationSec(route.staticDuration);
    if (traffic !== undefined && noTraffic !== undefined && traffic > noTraffic + 60) {
      out.hasTraffic = true;
    }
  }

  if (mode === "transit") {
    const allSteps = route.legs?.flatMap((l) => l.steps ?? []) ?? [];
    const transitSteps = allSteps
      .filter((s) => s.travelMode === "TRANSIT" && s.transitDetails)
      .map((s) => {
        const t = s.transitDetails!;
        const line = t.transitLine?.nameShort ?? t.transitLine?.name ?? t.transitLine?.vehicle?.name?.text ?? "?";
        const fromStation = t.stopDetails?.departureStop?.name ?? "?";
        const toStation = t.stopDetails?.arrivalStop?.name ?? "?";
        const depText = t.localizedValues?.departureTime?.time?.text;
        const arrText = t.localizedValues?.arrivalTime?.time?.text;
        return {
          line,
          fromStation,
          toStation,
          departureTime: depText,
          arrivalTime: arrText,
          numStops: t.stopCount,
        };
      });
    out.transitSteps = transitSteps;
    out.transitTransfers = Math.max(0, transitSteps.length - 1);
  }

  return out;
}

/**
 * Google Maps の transit deep link を組み立てる。
 * クリックで Google Maps が開き、正確な乗換案内が出る。
 */
function buildMapsTransitUrl(origin: string, destination: string): string {
  const params = new URLSearchParams({
    api: "1",
    origin,
    destination,
    travelmode: "transit",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

// ───── テキスト整形 (Yui tool 用) ─────

export function formatRouteSummary(resp: RouteResponse): string {
  const lines: string[] = [`${resp.origin} → ${resp.destination} のルート:`];
  for (const r of resp.results) {
    const label = r.mode === "transit" ? "電車" : r.mode === "driving" ? "車" : "徒歩";
    if (!r.ok) {
      lines.push(`[${label}] 取得できず (${r.error})`);
      continue;
    }
    if (r.mode === "transit") {
      // 駅すぱあと スタンダード等の構造化データが入ってる場合
      if (r.transitSteps && r.transitSteps.length > 0) {
        const transfers = r.transitTransfers !== undefined ? `乗換 ${r.transitTransfers} 回` : "";
        lines.push(`[${label}] 約 ${fmtDuration(r.durationSeconds!)}${transfers ? "、" + transfers : ""}`);
        for (const s of r.transitSteps) {
          const time = s.departureTime && s.arrivalTime ? ` (${s.departureTime} 発 → ${s.arrivalTime} 着)` : "";
          const stops = s.numStops ? `、${s.numStops} 駅` : "";
          lines.push(`   ${s.line} ${s.fromStation} → ${s.toStation}${time}${stops}`);
        }
      } else if (r.fallbackUrl) {
        // フォールバック: Google Maps の transit 画面リンクを返す
        lines.push(`[${label}] 正確な経路と乗換は Google Maps でご確認ください → ${r.fallbackUrl}`);
      } else {
        lines.push(`[${label}] 情報を取得できませんでした`);
      }
    } else if (r.mode === "driving") {
      const km = r.distanceMeters ? `、${(r.distanceMeters / 1000).toFixed(1)} km` : "";
      const traffic = r.hasTraffic ? " (混雑あり)" : "";
      lines.push(`[${label}] 約 ${fmtDuration(r.durationSeconds!)}${traffic}${km}`);
    } else {
      const km = r.distanceMeters ? `、${(r.distanceMeters / 1000).toFixed(1)} km` : "";
      lines.push(`[${label}] 約 ${fmtDuration(r.durationSeconds!)}${km}`);
    }
  }
  return lines.join("\n");
}

function fmtDuration(seconds: number): string {
  const min = Math.round(seconds / 60);
  if (min < 60) return `${min} 分`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (m === 0) return `${h} 時間`;
  return `${h} 時間 ${m} 分`;
}
