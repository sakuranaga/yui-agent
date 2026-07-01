/**
 * GET /api/weather
 * → 現在保存されている位置に対する天気取得結果を返す (5 分キャッシュ)。
 * Frontend (EnvironmentWidget) がポーリングする。
 */
import { NextResponse, type NextRequest } from "next/server";
import { getLocation, loadLocationFromDb } from "@/lib/location";
import { getCurrentWeather, isWeatherEnabled } from "@/lib/weather";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  if (!isWeatherEnabled()) {
    return NextResponse.json(
      { error: "weather not enabled" },
      { status: 503 }
    );
  }
  let loc = getLocation();
  if (!loc) {
    // web プロセス起動直後で未ロードなら DB から復元 (dedup 済み)。保険経路。
    await loadLocationFromDb();
    loc = getLocation();
  }
  if (!loc) {
    return NextResponse.json(
      { error: "no location set yet" },
      { status: 404 }
    );
  }
  try {
    const w = await getCurrentWeather({ lat: loc.lat, lon: loc.lon });
    // UI に「東京都 千代田区」のような場所ラベルも返す (location.placeLabel)
    return NextResponse.json({ ...w, placeLabel: loc.placeLabel ?? null });
  } catch (e) {
    return clientError(req, e, { status: 502, context: "weather", message: "現在の天気取得に失敗しました" });
  }
}
