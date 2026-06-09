/**
 * Open-Meteo 天気 API クライアント (OSS 化対応: 認証不要・無料・サインアップなし)。
 *
 * - https://open-meteo.com/ ISO 国際気象機関 (ノルウェー気象庁 等) 集約
 * - 個人利用なら 10,000 req/day 無料、認証ヘッダ不要、商用 OK
 * - 緯度経度を渡して current + daily forecast を取得
 * - サーバ側 cache (5 分) で過剰アクセス回避
 *
 * 内部表現は Apple WeatherKit 互換の condition code (Clear / Rain / Cloudy ...) に
 * 正規化してる (= 既存 UI の WeatherIcon mapping をそのまま流用するため)。
 */

const OPEN_METEO_BASE = "https://api.open-meteo.com/v1/forecast";

// 取得結果 (緯度経度) の cache TTL。5 分。
const WEATHER_CACHE_MS = 5 * 60 * 1000;

declare global {
  var __vroidWeatherCache:
    | Map<string, { fetchedAt: number; data: WeatherSnapshot }>
    | undefined;
}

/**
 * Open-Meteo は認証不要なので常に true。
 * 呼出元の「天気機能 enabled かどうか」判定 hook として残してる。
 */
export function isWeatherEnabled(): boolean {
  return true;
}

// --- Public types ---

export type WeatherSnapshot = {
  fetchedAt: string; // ISO
  lat: number;
  lon: number;
  /** "℃" の数値 */
  temperature: number;
  /** "感覚温度" */
  apparentTemperature: number;
  /** 湿度 0..1 */
  humidity: number;
  /** 内部正規化済の condition code ("Clear", "Cloudy", "Rain" 等 = WeatherIcon mapping 互換) */
  conditionCode: string;
  /** 日本語化した一文 ("晴れ", "曇り", "雨" 等) */
  conditionJa: string;
  /** 風速 m/s */
  windSpeed: number;
  /** 日中の最高/最低 (本日分があれば) */
  highTemperature?: number;
  lowTemperature?: number;
  /** true なら日中、false なら夜。UI でアイコンの昼/夜版切替に使う */
  daylight?: boolean;
};

// --- API ---

/**
 * 現在天気を取得 (5 分キャッシュ)。緯度経度に基づく。
 * 失敗時 throw。
 */
export async function getCurrentWeather(opts: {
  lat: number;
  lon: number;
  language?: string;
}): Promise<WeatherSnapshot> {
  const cache = (globalThis.__vroidWeatherCache ??= new Map());
  const key = `${opts.lat.toFixed(3)},${opts.lon.toFixed(3)}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < WEATHER_CACHE_MS) {
    return cached.data;
  }

  const url = new URL(OPEN_METEO_BASE);
  url.searchParams.set("latitude", String(opts.lat));
  url.searchParams.set("longitude", String(opts.lon));
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day"
  );
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  );
  url.searchParams.set("timezone", "Asia/Tokyo");
  url.searchParams.set("wind_speed_unit", "ms");
  url.searchParams.set("forecast_days", "2");

  // eslint-disable-next-line no-restricted-syntax -- Open-Meteo 公式 API endpoint 固定
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Open-Meteo ${res.status}: ${text.slice(0, 300)}`);
  }
  type Resp = {
    current?: {
      temperature_2m: number;
      apparent_temperature: number;
      relative_humidity_2m: number;
      weather_code: number;
      wind_speed_10m: number;
      is_day: number;
    };
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
    };
  };
  const data = (await res.json()) as Resp;
  if (!data.current) {
    throw new Error("Open-Meteo response missing current");
  }
  const cw = data.current;
  const today = data.daily;
  const code = wmoToAppleCode(cw.weather_code);
  const snapshot: WeatherSnapshot = {
    fetchedAt: new Date().toISOString(),
    lat: opts.lat,
    lon: opts.lon,
    temperature: cw.temperature_2m,
    apparentTemperature: cw.apparent_temperature,
    humidity: cw.relative_humidity_2m / 100, // 0..1 に正規化 (Apple 互換)
    conditionCode: code,
    conditionJa: conditionCodeToJa(code),
    windSpeed: cw.wind_speed_10m,
    highTemperature: today?.temperature_2m_max?.[0],
    lowTemperature: today?.temperature_2m_min?.[0],
    daylight: cw.is_day === 1,
  };
  cache.set(key, { fetchedAt: Date.now(), data: snapshot });
  return snapshot;
}

/**
 * 1 日分の天気予報 (週間天気 / Calendar 用)。
 * fetchedAt は DB 凍結時刻 (過去日は last fetch のまま、未来日は最新)。
 */
export type WeatherForecastDay = {
  date: string;                  // "YYYY-MM-DD" (JST)
  conditionCode: string;
  conditionJa: string;
  tempMax: number;
  tempMin: number;
  precipChance: number | null;   // 0..1
  fetchedAt: string;             // ISO
};

/** JST の YYYY-MM-DD */
function ymdJst(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Open-Meteo daily を 10 日分取得して、未来日のみ DB UPSERT。過去日は触らない */
export async function fetchAndUpsertForecast(opts: {
  lat: number;
  lon: number;
  days?: number;
}): Promise<WeatherForecastDay[]> {
  const days = Math.max(1, Math.min(16, opts.days ?? 10));
  const url = new URL(OPEN_METEO_BASE);
  url.searchParams.set("latitude", String(opts.lat));
  url.searchParams.set("longitude", String(opts.lon));
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max"
  );
  url.searchParams.set("timezone", "Asia/Tokyo");
  url.searchParams.set("forecast_days", String(days));

  // eslint-disable-next-line no-restricted-syntax -- Open-Meteo 公式 API endpoint 固定 (weekly)
  const res = await fetch(url.toString());
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Open-Meteo ${res.status}: ${text.slice(0, 300)}`);
  }
  type Resp = {
    daily?: {
      time?: string[];
      weather_code?: number[];
      temperature_2m_max?: number[];
      temperature_2m_min?: number[];
      precipitation_probability_max?: number[];
    };
  };
  const data = (await res.json()) as Resp;
  const daily = data.daily ?? {};
  const dates = daily.time ?? [];
  const codes = daily.weather_code ?? [];
  const maxes = daily.temperature_2m_max ?? [];
  const mins = daily.temperature_2m_min ?? [];
  const probs = daily.precipitation_probability_max ?? [];

  const today = ymdJst(new Date());
  const latRound = Math.round(opts.lat * 100) / 100;
  const lonRound = Math.round(opts.lon * 100) / 100;

  const { db } = await import("@/db/client");
  const { weatherDaily } = await import("@/db/schema");
  const { eq, and, gte } = await import("drizzle-orm");

  const upsertRows: Array<{
    latRound: number;
    lonRound: number;
    date: string;
    conditionCode: string;
    conditionJa: string;
    tempMax: number;
    tempMin: number;
    precipChance: number | null;
    fetchedAt: Date;
  }> = [];

  for (let i = 0; i < dates.length; i++) {
    const dateStr = dates[i]; // 既に YYYY-MM-DD 形式 (JST)
    if (dateStr < today) continue; // 過去日は凍結保護
    const code = wmoToAppleCode(codes[i] ?? 0);
    const probPct = probs[i];
    upsertRows.push({
      latRound,
      lonRound,
      date: dateStr,
      conditionCode: code,
      conditionJa: conditionCodeToJa(code),
      tempMax: maxes[i] ?? 0,
      tempMin: mins[i] ?? 0,
      precipChance:
        typeof probPct === "number" ? probPct / 100 : null, // 0..1 に正規化
      fetchedAt: new Date(),
    });
  }

  if (upsertRows.length > 0) {
    for (const row of upsertRows) {
      await db
        .insert(weatherDaily)
        .values(row)
        .onConflictDoUpdate({
          target: [weatherDaily.latRound, weatherDaily.lonRound, weatherDaily.date],
          set: {
            conditionCode: row.conditionCode,
            conditionJa: row.conditionJa,
            tempMax: row.tempMax,
            tempMin: row.tempMin,
            precipChance: row.precipChance,
            fetchedAt: row.fetchedAt,
          },
        });
    }
  }

  // Return ALL rows in [today-60, today+days] window for the calendar (past dates are frozen).
  const rangeStart = ymdJst(new Date(Date.now() - 60 * 24 * 60 * 60 * 1000));
  const rows = await db
    .select()
    .from(weatherDaily)
    .where(
      and(
        eq(weatherDaily.latRound, latRound),
        eq(weatherDaily.lonRound, lonRound),
        gte(weatherDaily.date, rangeStart)
      )
    )
    .orderBy(weatherDaily.date);

  return rows.map((r) => ({
    date: r.date,
    conditionCode: r.conditionCode,
    conditionJa: r.conditionJa ?? "",
    tempMax: r.tempMax,
    tempMin: r.tempMin,
    precipChance: r.precipChance,
    fetchedAt: r.fetchedAt.toISOString(),
  }));
}

/**
 * WMO weather code (= Open-Meteo の `weather_code`) を Apple WeatherKit の
 * condition code 命名に正規化する。これで既存 WeatherIcon の判定ロジックや
 * conditionCodeToJa が全部そのまま使える。
 *
 * WMO 仕様: https://open-meteo.com/en/docs (weather_code 章)
 */
function wmoToAppleCode(code: number): string {
  // 0: Clear sky
  if (code === 0) return "Clear";
  // 1: Mainly clear
  if (code === 1) return "MostlyClear";
  // 2: Partly cloudy
  if (code === 2) return "PartlyCloudy";
  // 3: Overcast
  if (code === 3) return "Cloudy";
  // 45, 48: Fog / depositing rime fog
  if (code === 45 || code === 48) return "Foggy";
  // 51, 53, 55: Drizzle: light / moderate / dense
  if (code === 51 || code === 53 || code === 55) return "Drizzle";
  // 56, 57: Freezing drizzle: light / dense
  if (code === 56 || code === 57) return "FreezingDrizzle";
  // 61, 63: Rain: slight / moderate
  if (code === 61 || code === 63) return "Rain";
  // 65: Rain: heavy
  if (code === 65) return "HeavyRain";
  // 66, 67: Freezing rain: light / heavy
  if (code === 66 || code === 67) return "FreezingRain";
  // 71: Snow fall: slight
  if (code === 71) return "Flurries";
  // 73: Snow fall: moderate
  if (code === 73) return "Snow";
  // 75: Snow fall: heavy
  if (code === 75) return "HeavySnow";
  // 77: Snow grains
  if (code === 77) return "Snow";
  // 80, 81: Rain showers: slight / moderate
  if (code === 80 || code === 81) return "Showers";
  // 82: Rain showers: violent
  if (code === 82) return "HeavyRain";
  // 85: Snow showers: slight
  if (code === 85) return "Flurries";
  // 86: Snow showers: heavy
  if (code === 86) return "HeavySnow";
  // 95: Thunderstorm: slight or moderate
  if (code === 95) return "Thunderstorms";
  // 96, 99: Thunderstorm with slight / heavy hail
  if (code === 96 || code === 99) return "Thunderstorms";
  // unknown
  return "Cloudy";
}

/**
 * 内部 condition code を日本語化。完全網羅は不要、よく出るやつだけ。
 */
function conditionCodeToJa(code: string): string {
  const map: Record<string, string> = {
    Clear: "快晴",
    MostlyClear: "おおむね晴れ",
    PartlyCloudy: "晴れ時々曇り",
    MostlyCloudy: "おおむね曇り",
    Cloudy: "曇り",
    Drizzle: "霧雨",
    Rain: "雨",
    HeavyRain: "強い雨",
    Showers: "にわか雨",
    Thunderstorms: "雷雨",
    Snow: "雪",
    HeavySnow: "大雪",
    Flurries: "小雪",
    Sleet: "みぞれ",
    Hail: "ひょう",
    Foggy: "霧",
    Haze: "もや",
    Smoke: "煙霧",
    Hot: "猛暑",
    Frigid: "厳寒",
    Windy: "強風",
    Breezy: "そよ風",
    Blizzard: "猛吹雪",
    BlowingDust: "砂塵嵐",
    BlowingSnow: "吹雪",
    FreezingDrizzle: "凍雨 (霧)",
    FreezingRain: "凍雨",
    Hurricane: "ハリケーン",
    IsolatedThunderstorms: "局所的な雷雨",
    ScatteredThunderstorms: "ところにより雷雨",
    SevereThunderstorm: "激しい雷雨",
    StrongStorms: "大荒れ",
    SunFlurries: "晴れ時々小雪",
    SunShowers: "晴れ時々雨",
    TropicalStorm: "熱帯低気圧",
    WintryMix: "雪・みぞれ混じり",
  };
  return map[code] ?? code;
}
