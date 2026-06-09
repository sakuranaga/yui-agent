/**
 * GET /api/mail/list
 *   メール一覧 (左ペイン用)。view (inbox/sent/archive/trash/starred) + sort + 検索。
 *
 * クエリ:
 *   view=inbox|sent|archive|trash|starred  (default: inbox)
 *   sort=score|date                         (default: score)
 *   limit                                   default 200
 *
 * 戻り値: { items, threshold, accounts, counts }
 *   counts: 各 view の件数 (タブのバッジ表示用)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages, gmailAccounts } from "@/db/schema";
import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { getMailCurationSettings } from "@/lib/mail-curation-settings";
import { listGmailAccounts } from "@/lib/mail-accounts";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

type View = "inbox" | "sent" | "archive" | "trash" | "starred";

function buildViewCondition(view: View) {
  switch (view) {
    case "inbox":
      // not archived, not trashed, not in SENT label
      return and(
        isNull(mailMessages.archivedAt),
        isNull(mailMessages.trashedAt),
        sql`NOT ('SENT' = ANY(${mailMessages.labels}))`
      );
    case "sent":
      return and(
        isNull(mailMessages.trashedAt),
        sql`'SENT' = ANY(${mailMessages.labels})`
      );
    case "archive":
      return and(
        isNotNull(mailMessages.archivedAt),
        isNull(mailMessages.trashedAt)
      );
    case "trash":
      return isNotNull(mailMessages.trashedAt);
    case "starred":
      return and(
        isNotNull(mailMessages.starredAt),
        isNull(mailMessages.trashedAt)
      );
  }
}

export async function GET(req: NextRequest) {
  const viewRaw = req.nextUrl.searchParams.get("view") ?? "inbox";
  const view: View = (
    ["inbox", "sent", "archive", "trash", "starred"].includes(viewRaw) ? viewRaw : "inbox"
  ) as View;
  // sort=date は明示指定。default は bucket (important → needed → unneeded → 未分類)
  //   + 受信時刻降順。旧 sort=score は bucket 並びにマップ (legacy 互換)。
  const sortRaw = req.nextUrl.searchParams.get("sort");
  const sort: "date" | "bucket" =
    sortRaw === "date" ? "date" : "bucket";
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 200;

  try {
    const cond = buildViewCondition(view);

    // bucket 並び: important=3, needed=2, unclassified=1, unneeded=0 で desc
    // SQL CASE で計算列を作って sort key にする (index は無いが受信箱規模なら問題なし)
    const bucketOrder = sql<number>`CASE
      WHEN ${mailMessages.bucket} = 'important' THEN 3
      WHEN ${mailMessages.bucket} = 'needed'    THEN 2
      WHEN ${mailMessages.bucket} IS NULL       THEN 1
      WHEN ${mailMessages.bucket} = 'unneeded'  THEN 0
      ELSE 1 END`;
    const order =
      sort === "date"
        ? [desc(mailMessages.receivedAt), desc(mailMessages.id)]
        // bucket 内では score (= バケット内重要度) 降順、その次は受信時刻
        : [desc(bucketOrder), desc(mailMessages.score), desc(mailMessages.receivedAt), desc(mailMessages.id)];

    const rows = await db
      .select({
        id: mailMessages.id,
        gmailMessageId: mailMessages.gmailMessageId,
        gmailThreadId: mailMessages.gmailThreadId,
        accountEmail: gmailAccounts.email,
        fromName: mailMessages.fromName,
        fromEmail: mailMessages.fromEmail,
        subject: mailMessages.subject,
        snippet: mailMessages.snippet,
        receivedAt: mailMessages.receivedAt,
        labels: mailMessages.labels,
        score: mailMessages.score,
        scoreReason: mailMessages.scoreReason,
        bucket: mailMessages.bucket,
        bucketConfidence: mailMessages.bucketConfidence,
        bucketReason: mailMessages.bucketReason,
        readAt: mailMessages.readAt,
        starredAt: mailMessages.starredAt,
        archivedAt: mailMessages.archivedAt,
        trashedAt: mailMessages.trashedAt,
        hasBody: mailMessages.bodyFetchedAt,
      })
      .from(mailMessages)
      .innerJoin(gmailAccounts, eq(mailMessages.accountId, gmailAccounts.id))
      .where(cond)
      .orderBy(...order)
      .limit(limit);

    const settings = await getMailCurationSettings();
    const accounts = await listGmailAccounts();

    // 全 view の count を 1 クエリで返す
    const [countRow] = await db
      .select({
        inbox: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.archivedAt} IS NULL AND ${mailMessages.trashedAt} IS NULL AND NOT ('SENT' = ANY(${mailMessages.labels})))`,
        sent: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.trashedAt} IS NULL AND 'SENT' = ANY(${mailMessages.labels}))`,
        archive: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.archivedAt} IS NOT NULL AND ${mailMessages.trashedAt} IS NULL)`,
        trash: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.trashedAt} IS NOT NULL)`,
        starred: sql<number>`COUNT(*) FILTER (WHERE ${mailMessages.starredAt} IS NOT NULL AND ${mailMessages.trashedAt} IS NULL)`,
      })
      .from(mailMessages);

    return NextResponse.json({
      threshold: settings.scoreThreshold,
      view,
      counts: {
        inbox: Number(countRow.inbox),
        sent: Number(countRow.sent),
        archive: Number(countRow.archive),
        trash: Number(countRow.trash),
        starred: Number(countRow.starred),
      },
      accounts: accounts.map((a) => ({
        id: Number(a.id),
        email: a.email,
        displayName: a.displayName,
        enabled: a.enabled,
        isPrimary: a.isPrimary,
      })),
      items: rows.map((r) => ({
        id: Number(r.id),
        accountEmail: r.accountEmail,
        threadId: r.gmailThreadId,
        gmailMessageId: r.gmailMessageId,
        fromName: r.fromName,
        fromEmail: r.fromEmail,
        subject: r.subject,
        snippet: r.snippet,
        receivedAt: r.receivedAt.toISOString(),
        labels: r.labels ?? [],
        score: r.score,
        scoreReason: r.scoreReason,
        bucket: r.bucket,
        bucketConfidence: r.bucketConfidence,
        bucketReason: r.bucketReason,
        read: r.readAt !== null,
        starred: r.starredAt !== null,
        archived: r.archivedAt !== null,
        trashed: r.trashedAt !== null,
        hasBody: r.hasBody !== null,
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "mail/list", message: "メール一覧の取得に失敗しました" });
  }
}
