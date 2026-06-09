/**
 * POST /api/mail/fetch-bodies
 *   既存の閾値超え メールで body 未取得 (body_fetched_at IS NULL) のものを
 *   一括 fetch する。MailModal で「過去分も本文取得」とか curate threshold を
 *   変えたあと使う想定。
 *
 * POST /api/mail/fetch-bodies?id=<n>
 *   単一メッセージだけ fetch (UI から「本文取得」ボタン用)。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
import { and, gte, isNull } from "drizzle-orm";
import { fetchBodiesForMessages } from "@/lib/mail-body";
import { getMailCurationSettings } from "@/lib/mail-curation-settings";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const single = req.nextUrl.searchParams.get("id");
  try {
    let targets: number[];
    if (single) {
      const id = parseInt(single, 10);
      if (!Number.isFinite(id)) {
        return NextResponse.json({ error: "invalid id" }, { status: 400 });
      }
      targets = [id];
    } else {
      const settings = await getMailCurationSettings();
      const rows = await db
        .select({ id: mailMessages.id })
        .from(mailMessages)
        .where(
          and(
            gte(mailMessages.score, settings.scoreThreshold),
            isNull(mailMessages.bodyFetchedAt),
            isNull(mailMessages.trashedAt)
          )
        )
        .limit(200);
      targets = rows.map((r) => r.id);
    }
    if (targets.length === 0) {
      return NextResponse.json({ ok: true, fetched: 0 });
    }
    const r = await fetchBodiesForMessages(targets);
    return NextResponse.json({ ok: true, fetched: r.fetched, requested: targets.length });
  } catch (e) {
    return clientError(req, e, { context: "mail/fetch-bodies", message: "メール本文の取得に失敗しました" });
  }
}
