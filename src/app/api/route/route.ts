/**
 * GET /api/route?destination=末広町&from=渋谷&modes=transit,driving,walking
 *   ルート比較を返す。modes 省略時は 3 種すべて。
 *   from 省略時は getLocation() (= ブラウザ位置情報) を使う。
 *
 * 設計: docs (routing — 道案内 tool)
 */
import { NextResponse, type NextRequest } from "next/server";
import { getRoute, formatRouteSummary, type RouteMode } from "@/lib/routing";

export const dynamic = "force-dynamic";

const VALID_MODES: ReadonlyArray<RouteMode> = ["transit", "driving", "walking"];

export async function GET(req: NextRequest) {
  const destination = req.nextUrl.searchParams.get("destination");
  if (!destination) {
    return NextResponse.json({ error: "destination required" }, { status: 400 });
  }
  const from = req.nextUrl.searchParams.get("from") ?? undefined;
  const modesParam = req.nextUrl.searchParams.get("modes");
  const modes = modesParam
    ? (modesParam.split(",").filter((m) => VALID_MODES.includes(m as RouteMode)) as RouteMode[])
    : undefined;

  const result = await getRoute({ destination, from, modes });
  return NextResponse.json({
    ...result,
    summary: formatRouteSummary(result),
  });
}
