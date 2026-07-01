"use client";

/**
 * 画面左上の常駐ウィジェット: 時刻 / 日付 / 天気 / 場所。
 *
 * 旧 ChatHeaderClock + WeatherBadge を統合してビューア左上に配置。
 *
 * 表示構成:
 *   [天気アイコン]  23.6°C
 *                  東京都 千代田区
 *                  晴れ時々曇り
 *                  ─────
 *                  5月28日(木) 03:08:42
 *
 * - 位置取得 (navigator.geolocation) → POST /api/location → サーバ側 reverse geocode
 * - 5 分毎 (visible 中は 1 分毎) /api/weather refresh
 * - 時刻は 1 秒毎にローカル更新
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  getJapaneseEraYear,
  getMoonPhaseName,
  getRokuyou,
  getWeekdayShort,
} from "@/lib/japanese-calendar";

const WEATHER_REFRESH_MS = 5 * 60 * 1000;

type Weather = {
  temperature: number;
  conditionJa: string;
  conditionCode: string;
  humidity: number;
  highTemperature?: number;
  lowTemperature?: number;
  daylight?: boolean;
  placeLabel?: string | null;
};

function fmt2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

export default function EnvironmentWidget() {
  // 時刻は lazy init で「mount 時の現在時刻」を取り込み、その後 setInterval で 1 秒更新。
  const [now, setNow] = useState<Date>(() => new Date());
  const [weather, setWeather] = useState<Weather | null>(null);
  const [locOk, setLocOk] = useState<boolean | null>(null);

  // 時刻 1 秒毎更新
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  // 位置取得 → POST /api/location
  useEffect(() => {
    if (typeof window === "undefined" || !navigator.geolocation) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- env capability flag
      setLocOk(false);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const { latitude, longitude, accuracy } = pos.coords;
        void fetch("/api/location", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ lat: latitude, lon: longitude, accuracy }),
        })
          .then(() => setLocOk(true))
          .catch(() => setLocOk(false));
      },
      (err) => {
        console.warn("[env-widget] geolocation error:", err.message);
        setLocOk(false);
      },
      { enableHighAccuracy: false, maximumAge: 5 * 60 * 1000, timeout: 10_000 }
    );
  }, []);

  const refreshWeather = useCallback(async () => {
    try {
      const res = await fetch("/api/weather", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as Weather;
      if (typeof data.temperature === "number") setWeather(data);
    } catch (e) {
      console.warn("[env-widget] weather fetch failed:", e);
    }
  }, []);

  useEffect(() => {
    // ブラウザ geolocation の成否に関わらず weather を取りに行く。
    // サーバは DB に保存済みの location から天気を返せる (locOk=false でも表示される)。
    // 未設定なら /api/weather が 404 → refreshWeather は no-op で weather 非表示のまま。
    // locOk が true に変わった (= 新しい位置を post した) 直後は即時 refresh したいので
    // locOk を依存に残す。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- mount fetch + polling
    void refreshWeather();
    const id = setInterval(refreshWeather, WEATHER_REFRESH_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshWeather();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [locOk, refreshWeather]);

  const month = now.getMonth() + 1;
  const day = now.getDate();
  const weekday = getWeekdayShort(now);
  const year = now.getFullYear();
  const era = getJapaneseEraYear(now);
  const rokuyou = getRokuyou(now);
  const moon = getMoonPhaseName(now);
  const h = fmt2(now.getHours());
  const m = fmt2(now.getMinutes());
  const s = fmt2(now.getSeconds());

  return (
    <div className="env-widget" aria-label="現在の環境">
      <div className="env-sub">
        {year}年 ({era}) · {rokuyou} · {moon}
      </div>
      <div className="env-main">
        <span className="env-date">
          {month}月{day}日<span className="env-weekday">({weekday}曜日)</span>
        </span>
        <span className="env-clock">
          {h}:{m}
          <span className="env-clock-sec">:{s}</span>
        </span>
        {weather && <WeatherClickable weather={weather} />}
      </div>
    </div>
  );
}

/**
 * 今日の天気バッジ + クリックで 10 日週間天気 popover。
 * popover 内は同じ PNG リッチアイコン (iconPathFor) を使う。
 */
type ForecastDay = {
  date: string;
  conditionCode: string;
  conditionJa: string;
  tempMax: number;
  tempMin: number;
  precipChance: number | null;
};

function WeatherClickable({ weather }: { weather: Weather }) {
  const [open, setOpen] = useState(false);
  const [forecast, setForecast] = useState<ForecastDay[] | null>(null);
  const [forecastLoading, setForecastLoading] = useState(false);
  const ref = useRef<HTMLSpanElement | null>(null);

  // 開いた瞬間に refetch (予報は毎日変わる)
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    setForecastLoading(true);
    (async () => {
      try {
        const res = await fetch("/api/weather/forecast?days=10", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { forecast: ForecastDay[] };
        if (!cancelled) setForecast(data.forecast ?? []);
      } catch (e) {
        console.warn("[env-widget] forecast fetch failed:", e);
      } finally {
        if (!cancelled) setForecastLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  // 外クリック / Esc で close
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // 今日以降 10 日分のみ表示 (週間天気の枠組み)
  const today = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  })
    .format(new Date())
    .replace(/\//g, "-");
  const futureDays = (forecast ?? []).filter((d) => d.date >= today).slice(0, 10);

  return (
    <span className="env-weather env-weather-clickable" ref={ref}>
      <button
        type="button"
        className="env-weather-trigger"
        onClick={() => setOpen((v) => !v)}
        aria-label="週間天気を表示"
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={iconPathFor(weather.conditionCode, weather.daylight)}
          alt=""
          className="env-weather-icon"
        />
        <span className="env-weather-text">
          {weather.placeLabel && (
            <span className="env-weather-place">{weather.placeLabel}</span>
          )}
          <span className="env-weather-row">
            <span className="env-weather-cond">{weather.conditionJa}</span>
            <span className="env-weather-temp">
              {weather.temperature.toFixed(1)}
              <span className="env-weather-unit">°C</span>
            </span>
          </span>
        </span>
      </button>
      {open && (
        <div className="env-forecast-popover" role="dialog">
          <div className="env-forecast-head">週間天気 (10 日)</div>
          {forecastLoading && futureDays.length === 0 ? (
            <div className="env-forecast-loading">読み込み中…</div>
          ) : futureDays.length === 0 ? (
            <div className="env-forecast-loading">予報データなし</div>
          ) : (
            <div className="env-forecast-list">
              {futureDays.map((d) => {
                const dt = new Date(`${d.date}T00:00:00+09:00`);
                const wd = ["日", "月", "火", "水", "木", "金", "土"][dt.getDay()];
                const md = `${dt.getMonth() + 1}/${dt.getDate()}`;
                const isToday = d.date === today;
                return (
                  <div key={d.date} className={`env-forecast-row ${isToday ? "today" : ""}`}>
                    <span className="env-forecast-date">
                      {md}
                      <span className="env-forecast-wd">({wd})</span>
                    </span>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={iconPathFor(d.conditionCode, true)}
                      alt=""
                      className="env-forecast-icon"
                    />
                    <span className="env-forecast-cond">{d.conditionJa}</span>
                    <span className="env-forecast-temps">
                      <span className="env-forecast-high">{Math.round(d.tempMax)}°</span>
                      <span className="env-forecast-low">{Math.round(d.tempMin)}°</span>
                    </span>
                    {d.precipChance !== null && d.precipChance > 0 && (
                      <span className="env-forecast-precip">
                        {Math.round(d.precipChance * 100)}%
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/**
 * Apple WeatherKit conditionCode → public/weather/<Name>.png のパス。
 * 夜 (daylight=false) は Clear/MostlyClear のみ ClearNight に切替。他 code は昼夜共通。
 * 該当 image が無い code は Cloudy にフォールバック (Foggy/Haze/Smoke 等)。
 */
function iconPathFor(code: string, daylight?: boolean): string {
  const isNight = daylight === false;
  const name = (() => {
    if (/^(Clear|MostlyClear)$/.test(code)) return isNight ? "ClearNight" : "Clear";
    if (code === "Hot") return "Hot";
    if (code === "Frigid") return "Frigid";
    if (code === "PartlyCloudy") return "PartlyCloudy";
    if (/^(Cloudy|MostlyCloudy)$/.test(code)) return "Cloudy";
    if (/^(Foggy|Haze|Smoke)$/.test(code)) return "Cloudy"; // fallback
    if (code === "Drizzle") return "Drizzle";
    if (/^(Rain|HeavyRain|FreezingRain)$/.test(code)) return code === "HeavyRain" ? "HeavyRain" : "Rain";
    if (code === "Showers") return "Showers";
    if (code === "SunShowers") return "SunShowers";
    if (/Thunderstorm|StrongStorms/.test(code)) return "Thunderstorms";
    if (/^(Snow|HeavySnow|Flurries|Blizzard|SnowShowers|SunFlurries)$/.test(code)) return "Snow";
    if (/^(Sleet|WintryMix|FreezingDrizzle|Hail)$/.test(code)) return "Sleet";
    if (/^(Windy|Breezy|Hurricane|TropicalStorm)$/.test(code)) return "Hurricane";
    if (code === "Dust") return "Dust";
    return "Cloudy";
  })();
  return `/weather/${name}.png`;
}
