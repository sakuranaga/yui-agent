/**
 * GET /api/mail/<id>
 *   詳細 (本文 + thread 中の他メール + 添付メタ)。
 *   本文未取得なら lazy fetch する。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages, mailAttachments, gmailAccounts, mailTrainingExamples } from "@/db/schema";
import { eq, asc, and, isNull, desc } from "drizzle-orm";
import { fetchBodiesForMessages } from "@/lib/mail-body";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    let [row] = await db
      .select({
        id: mailMessages.id,
        gmailMessageId: mailMessages.gmailMessageId,
        gmailThreadId: mailMessages.gmailThreadId,
        accountId: mailMessages.accountId,
        accountEmail: gmailAccounts.email,
        fromAddress: mailMessages.fromAddress,
        fromName: mailMessages.fromName,
        fromEmail: mailMessages.fromEmail,
        toAddresses: mailMessages.toAddresses,
        subject: mailMessages.subject,
        snippet: mailMessages.snippet,
        receivedAt: mailMessages.receivedAt,
        labels: mailMessages.labels,
        score: mailMessages.score,
        scoreReason: mailMessages.scoreReason,
        bucket: mailMessages.bucket,
        bucketConfidence: mailMessages.bucketConfidence,
        bucketReason: mailMessages.bucketReason,
        classifiedAt: mailMessages.classifiedAt,
        bodyText: mailMessages.bodyText,
        bodyHtml: mailMessages.bodyHtml,
        bodyFetchedAt: mailMessages.bodyFetchedAt,
        readAt: mailMessages.readAt,
        starredAt: mailMessages.starredAt,
        archivedAt: mailMessages.archivedAt,
        trashedAt: mailMessages.trashedAt,
      })
      .from(mailMessages)
      .innerJoin(gmailAccounts, eq(mailMessages.accountId, gmailAccounts.id))
      .where(eq(mailMessages.id, numId))
      .limit(1);

    if (!row) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // body 未取得なら lazy fetch
    if (!row.bodyFetchedAt) {
      await fetchBodiesForMessages([numId]);
      const [refreshed] = await db
        .select({
          id: mailMessages.id,
          gmailMessageId: mailMessages.gmailMessageId,
          gmailThreadId: mailMessages.gmailThreadId,
          accountId: mailMessages.accountId,
          accountEmail: gmailAccounts.email,
          fromAddress: mailMessages.fromAddress,
          fromName: mailMessages.fromName,
          fromEmail: mailMessages.fromEmail,
          toAddresses: mailMessages.toAddresses,
          subject: mailMessages.subject,
          snippet: mailMessages.snippet,
          receivedAt: mailMessages.receivedAt,
          labels: mailMessages.labels,
          score: mailMessages.score,
          scoreReason: mailMessages.scoreReason,
          bucket: mailMessages.bucket,
          bucketConfidence: mailMessages.bucketConfidence,
          bucketReason: mailMessages.bucketReason,
          classifiedAt: mailMessages.classifiedAt,
          bodyText: mailMessages.bodyText,
          bodyHtml: mailMessages.bodyHtml,
          bodyFetchedAt: mailMessages.bodyFetchedAt,
          readAt: mailMessages.readAt,
          starredAt: mailMessages.starredAt,
          archivedAt: mailMessages.archivedAt,
          trashedAt: mailMessages.trashedAt,
        })
        .from(mailMessages)
        .innerJoin(gmailAccounts, eq(mailMessages.accountId, gmailAccounts.id))
        .where(eq(mailMessages.id, numId))
        .limit(1);
      if (refreshed) row = refreshed;
    }

    // thread 中の他メール (deleted は除く)
    const threadRows = await db
      .select({
        id: mailMessages.id,
        fromName: mailMessages.fromName,
        fromEmail: mailMessages.fromEmail,
        subject: mailMessages.subject,
        receivedAt: mailMessages.receivedAt,
      })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.gmailThreadId, row.gmailThreadId),
          isNull(mailMessages.trashedAt)
        )
      )
      .orderBy(asc(mailMessages.receivedAt));

    // 添付メタ
    const attachments = await db
      .select()
      .from(mailAttachments)
      .where(eq(mailAttachments.messageId, numId));

    // このメールに紐づく直近の学習例 (訂正で複数できることがある、最新だけ)。
    // modal の pre-fill (bucket / hint / auto_todo / auto_event) に使う。
    const [latestTraining] = await db
      .select({
        bucket: mailTrainingExamples.bucket,
        hintText: mailTrainingExamples.hintText,
        autoTodo: mailTrainingExamples.autoTodo,
        autoEvent: mailTrainingExamples.autoEvent,
      })
      .from(mailTrainingExamples)
      .where(eq(mailTrainingExamples.sourceMailId, numId))
      .orderBy(desc(mailTrainingExamples.createdAt))
      .limit(1);

    return NextResponse.json({
      id: Number(row.id),
      gmailMessageId: row.gmailMessageId,
      threadId: row.gmailThreadId,
      accountEmail: row.accountEmail,
      from: { address: row.fromAddress, name: row.fromName, email: row.fromEmail },
      to: row.toAddresses ?? [],
      subject: row.subject,
      snippet: row.snippet,
      receivedAt: row.receivedAt.toISOString(),
      labels: row.labels ?? [],
      score: row.score,
      scoreReason: row.scoreReason,
      bucket: row.bucket,
      bucketConfidence: row.bucketConfidence,
      bucketReason: row.bucketReason,
      classifiedAt: row.classifiedAt?.toISOString() ?? null,
      bodyText: row.bodyText,
      bodyHtml: row.bodyHtml,
      bodyFetchedAt: row.bodyFetchedAt?.toISOString() ?? null,
      read: row.readAt !== null,
      starred: row.starredAt !== null,
      archived: row.archivedAt !== null,
      trashed: row.trashedAt !== null,
      thread: threadRows.map((t) => ({
        id: Number(t.id),
        fromName: t.fromName,
        fromEmail: t.fromEmail,
        subject: t.subject,
        receivedAt: t.receivedAt.toISOString(),
      })),
      attachments: attachments.map((a) => ({
        id: Number(a.id),
        filename: a.filename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes !== null ? Number(a.sizeBytes) : null,
        gmailPartId: a.gmailPartId,
      })),
      latestTraining: latestTraining
        ? {
            bucket: latestTraining.bucket as "important" | "needed" | "unneeded",
            hintText: latestTraining.hintText,
            autoTodo: latestTraining.autoTodo,
            autoEvent: latestTraining.autoEvent,
          }
        : null,
    });
  } catch (e) {
    return clientError(req, e, { context: "mail/[id]", message: "メールの取得に失敗しました" });
  }
}
