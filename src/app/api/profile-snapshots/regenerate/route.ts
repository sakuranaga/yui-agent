/**
 * POST /api/profile-snapshots/regenerate?date=YYYY-MM-DD
 *   指定日 (省略時は今日) のスナップショットを手動で再生成 (upsert)。
 *   初回キック / 訂正反映 / 動作確認用。
 */
import { NextResponse, type NextRequest } from "next/server";
import { generateProfileSnapshot } from "@/lib/user-profile";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const dateParam = req.nextUrl.searchParams.get("date");
  const target = dateParam ? new Date(`${dateParam}T12:00:00+09:00`) : new Date();
  if (Number.isNaN(target.getTime())) {
    return NextResponse.json({ error: "invalid date" }, { status: 400 });
  }
  try {
    const snapshot = await generateProfileSnapshot(target, "manual");
    return NextResponse.json({ snapshot });
  } catch (e) {
    return clientError(req, e, { context: "profile-snapshots/regenerate", message: "プロフィールスナップショットの再生成に失敗しました" });
  }
}
