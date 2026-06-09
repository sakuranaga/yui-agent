/**
 * GET /api/profile-snapshots?limit=14
 *   直近 N 件のスナップショットを新しい順に返す。
 *
 * 設計: docs/user-profile-snapshot.md
 */
import { NextResponse, type NextRequest } from "next/server";
import { loadRecentProfiles } from "@/lib/user-profile";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "14", 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 14;
  const items = await loadRecentProfiles(limit);
  return NextResponse.json({ count: items.length, items });
}
