/**
 * GET /api/weather/forecast?days=10
 *   週単位の天気予報 (デフォルト 10 日)。Open-Meteo fetch + 未来日 UPSERT、過去日は
 *   凍結のまま返す。EnvironmentWidget 吹き出し / CalendarModal 日付セル 共通データ源。
 */
import { NextResponse, type NextRequest } from "next/server";
import { getLocation, loadLocationFromDb } from "@/lib/location";
import { fetchAndUpsertForecast, isWeatherEnabled } from "@/lib/weather";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  if (!isWeatherEnabled()) {
    return NextResponse.json({ error: "weather not enabled" }, { status: 503 });
  }
  let loc = getLocation();
  if (!loc) {
    // web プロセス起動直後で未ロードなら DB から復元 (dedup 済み)。保険経路。
    await loadLocationFromDb();
    loc = getLocation();
  }
  if (!loc) {
    return NextResponse.json({ error: "no location set yet" }, { status: 404 });
  }

  const daysRaw = parseInt(req.nextUrl.searchParams.get("days") ?? "10", 10);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(10, daysRaw)) : 10;

  try {
    const forecast = await fetchAndUpsertForecast({
      lat: loc.lat,
      lon: loc.lon,
      days,
    });
    return NextResponse.json({ forecast });
  } catch (e) {
    return clientError(req, e, { status: 502, context: "weather/forecast", message: "天気予報の取得に失敗しました" });
  }
}
