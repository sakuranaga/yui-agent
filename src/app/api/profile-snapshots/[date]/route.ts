/**
 * GET /api/profile-snapshots/[date]
 *   YYYY-MM-DD (JST) 指定の 1 件を返す。無ければ {snapshot: null}。
 */
import { NextResponse, type NextRequest } from "next/server";
import { loadProfileByDate } from "@/lib/user-profile";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ date: string }> }
) {
  const { date } = await ctx.params;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ error: "invalid date (YYYY-MM-DD)" }, { status: 400 });
  }
  const snapshot = await loadProfileByDate(date);
  return NextResponse.json({ snapshot });
}
