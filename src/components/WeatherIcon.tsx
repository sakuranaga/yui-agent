"use client";

/**
 * シンプル SVG 天気アイコン。currentColor + stroke で size / 色をプロパティで制御可能。
 *
 * Apple WeatherKit の condition code を 8 種にざっくり集約:
 *   sun     - 晴 (Clear, MostlyClear, Hot, Frigid)
 *   moon    - 夜の晴
 *   sunCloud- 晴れ時々曇り (PartlyCloudy, SunShowers, SunFlurries)
 *   cloud   - 曇り (Cloudy, MostlyCloudy)
 *   rain    - 雨 (Rain, HeavyRain, Showers, Drizzle, FreezingRain, FreezingDrizzle)
 *   snow    - 雪 (Snow, HeavySnow, Flurries, Sleet, Blizzard, BlowingSnow, WintryMix, Hail)
 *   thunder - 雷雨 (Thunderstorms, IsolatedThunderstorms, ScatteredThunderstorms, SevereThunderstorm, StrongStorms)
 *   fog     - 霧/もや (Foggy, Haze, Smoke, Dust, BlowingDust)
 *
 * CalendarModal の日付セル横の小さなアイコンに使用。
 * 今日の天気 (EnvironmentWidget) のリッチ表示は引き続き既存 PNG。
 */

type Shape = "sun" | "moon" | "sunCloud" | "cloud" | "rain" | "snow" | "thunder" | "fog";

function classifyCode(code: string, daylight?: boolean): Shape {
  if (/Thunder|StrongStorms/i.test(code)) return "thunder";
  if (/Snow|Flurries|Sleet|Blizzard|WintryMix|Hail/i.test(code)) return "snow";
  if (/Rain|Showers|Drizzle/i.test(code)) {
    if (/Sun/.test(code)) return "sunCloud"; // SunShowers
    return "rain";
  }
  if (/Foggy|Haze|Smoke|Dust/i.test(code)) return "fog";
  if (code === "PartlyCloudy" || /SunFlurries|SunShowers/i.test(code)) return "sunCloud";
  if (/Cloudy/i.test(code)) return "cloud";
  if (/^(Clear|MostlyClear|Hot|Frigid)$/i.test(code)) return daylight === false ? "moon" : "sun";
  return "cloud";
}

export default function WeatherIcon({
  code,
  daylight,
  size = 16,
  className,
}: {
  code: string;
  daylight?: boolean;
  size?: number;
  className?: string;
}) {
  const shape = classifyCode(code, daylight);
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-label={code}
    >
      {shape === "sun" && (
        <>
          <circle cx="12" cy="12" r="4" />
          <line x1="12" y1="2" x2="12" y2="4" />
          <line x1="12" y1="20" x2="12" y2="22" />
          <line x1="2" y1="12" x2="4" y2="12" />
          <line x1="20" y1="12" x2="22" y2="12" />
          <line x1="4.93" y1="4.93" x2="6.34" y2="6.34" />
          <line x1="17.66" y1="17.66" x2="19.07" y2="19.07" />
          <line x1="4.93" y1="19.07" x2="6.34" y2="17.66" />
          <line x1="17.66" y1="6.34" x2="19.07" y2="4.93" />
        </>
      )}
      {shape === "moon" && (
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      )}
      {shape === "sunCloud" && (
        <>
          <circle cx="8" cy="8" r="3" />
          <line x1="8" y1="2" x2="8" y2="3" />
          <line x1="2" y1="8" x2="3" y2="8" />
          <line x1="3.5" y1="3.5" x2="4.2" y2="4.2" />
          <path d="M19 18a3 3 0 0 0-1.4-5.7 4.5 4.5 0 0 0-8.6 1.4A3 3 0 0 0 9 18z" />
        </>
      )}
      {shape === "cloud" && (
        <path d="M18 19a4 4 0 0 0-1.9-7.6 5.5 5.5 0 0 0-10.5 1.8A4 4 0 0 0 6 19z" />
      )}
      {shape === "rain" && (
        <>
          <path d="M18 14a4 4 0 0 0-1.9-7.6 5.5 5.5 0 0 0-10.5 1.8A4 4 0 0 0 6 14z" />
          <line x1="9" y1="17" x2="8" y2="22" />
          <line x1="13" y1="17" x2="12" y2="22" />
          <line x1="17" y1="17" x2="16" y2="22" />
        </>
      )}
      {shape === "snow" && (
        <>
          <path d="M18 14a4 4 0 0 0-1.9-7.6 5.5 5.5 0 0 0-10.5 1.8A4 4 0 0 0 6 14z" />
          <line x1="9" y1="18" x2="9" y2="19" />
          <line x1="13" y1="20" x2="13" y2="21" />
          <line x1="17" y1="18" x2="17" y2="19" />
        </>
      )}
      {shape === "thunder" && (
        <>
          <path d="M18 13a4 4 0 0 0-1.9-7.6 5.5 5.5 0 0 0-10.5 1.8A4 4 0 0 0 6 13z" />
          <polyline points="13 14 11 18 14 18 10 22" />
        </>
      )}
      {shape === "fog" && (
        <>
          <line x1="5" y1="9" x2="19" y2="9" />
          <line x1="3" y1="14" x2="21" y2="14" />
          <line x1="6" y1="19" x2="18" y2="19" />
        </>
      )}
    </svg>
  );
}
