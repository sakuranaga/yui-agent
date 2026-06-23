/**
 * POST /api/mail/curate
 *   未 curate な mail_messages 全件 (もしくは ?ids=1,2,3 で指定) を再キュレーション。
 *   将来 MailModal ヘッダの「再キュレーション」ボタンから呼ぶ想定。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
import { isNull } from "drizzle-orm";
import { enqueueBackgroundJob } from "@/lib/jobs/background";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const idsParam = req.nextUrl.searchParams.get("ids");
  try {
    let targetIds: number[];
    if (idsParam) {
      targetIds = idsParam
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => Number.isFinite(n));
    } else {
      const rows = await db
        .select({ id: mailMessages.id })
        .from(mailMessages)
        .where(isNull(mailMessages.curatedAt))
        .limit(500);
      targetIds = rows.map((r) => r.id);
    }
    if (targetIds.length === 0) {
      return NextResponse.json({ ok: true, count: 0 });
    }
    const job = await enqueueBackgroundJob({
      jobType: "mail.curate",
      payload: { ids: targetIds },
      dedupKey: `mail.curate:${targetIds.slice().sort((a, b) => a - b).join(",")}`,
      priority: 110,
    });
    return NextResponse.json({ ok: true, count: targetIds.length, jobId: job.id }, { status: 202 });
  } catch (e) {
    return clientError(req, e, { context: "mail/curate", message: "メールの再キュレーションに失敗しました" });
  }
}
