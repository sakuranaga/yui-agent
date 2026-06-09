/**
 * POST /api/location { lat, lon, accuracy? }
 *   → Frontend が navigator.geolocation から取得した位置を保存。
 * GET /api/location
 *   → 現在保存されている位置を返す (デバッグ / 復元用)。
 */
import { NextResponse } from "next/server";
import { getLocation, setLocation } from "@/lib/location";

export async function GET() {
  return NextResponse.json({ location: getLocation() });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const b = body as Record<string, unknown>;
  const lat = typeof b.lat === "number" ? b.lat : NaN;
  const lon = typeof b.lon === "number" ? b.lon : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return NextResponse.json({ error: "lat/lon required (number)" }, { status: 400 });
  }
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
    return NextResponse.json({ error: "lat/lon out of range" }, { status: 400 });
  }
  setLocation({
    lat,
    lon,
    accuracy: typeof b.accuracy === "number" ? b.accuracy : undefined,
    updatedAt: Date.now(),
  });
  return NextResponse.json({ ok: true });
}
