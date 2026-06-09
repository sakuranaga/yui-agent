/**
 * POST /api/mail-training       学習例追加 (元 mail から embed して保存)
 * GET  /api/mail-training        一覧 (デバッグ / 管理用)
 *
 * 設計: docs/mail-classification.md §7.1
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages, mailTrainingExamples, gmailAccounts } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { embed } from "@/lib/embed";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

// mail-curate.ts と同じ値。bge-m3 サーバの batch size (512 tokens) に収まるよう短めに。
const BODY_HEAD_CHARS = 600;

type PostBody = {
  mailId: number;
  bucket: "important" | "needed" | "unneeded";
  hintText: string;
  // Phase 2 で追加: 重要 を選んだ時のみ意味あり、Phase 3 で auto-action ゲートに使用
  autoTodo?: boolean;
  autoEvent?: boolean;
};

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as PostBody;
    if (
      typeof body.mailId !== "number" ||
      !["important", "needed", "unneeded"].includes(body.bucket) ||
      typeof body.hintText !== "string" ||
      body.hintText.trim().length === 0
    ) {
      return NextResponse.json({ error: "invalid body" }, { status: 400 });
    }

    const [mail] = await db
      .select({
        id: mailMessages.id,
        fromEmail: mailMessages.fromEmail,
        fromName: mailMessages.fromName,
        toAddresses: mailMessages.toAddresses,
        accountEmail: gmailAccounts.email,
        subject: mailMessages.subject,
        bodyText: mailMessages.bodyText,
      })
      .from(mailMessages)
      .innerJoin(gmailAccounts, eq(mailMessages.accountId, gmailAccounts.id))
      .where(eq(mailMessages.id, body.mailId));
    if (!mail) {
      return NextResponse.json({ error: "mail not found" }, { status: 404 });
    }

    // mail-curate.ts と同じフォーマット (from/to/account/subject + body)。
    // 学習例の embedding と推論時の query embedding を揃えるために必須。
    const from = mail.fromName ? `${mail.fromName} <${mail.fromEmail}>` : mail.fromEmail;
    const to = (mail.toAddresses ?? []).join(", ") || "(unknown)";
    const embeddedText = [
      `from: ${from}`,
      `to: ${to}`,
      `account: ${mail.accountEmail}`,
      `subject: ${(mail.subject ?? "").trim()}`,
      "",
      (mail.bodyText ?? "").slice(0, BODY_HEAD_CHARS),
    ]
      .join("\n")
      .trim();
    if (embeddedText.length === 0) {
      return NextResponse.json(
        { error: "mail has no content to embed (subject + body empty)" },
        { status: 400 }
      );
    }

    // 重要 でないなら auto_* は強制 false (UI でも非表示だが念のため)
    const autoTodo = body.bucket === "important" && body.autoTodo === true;
    const autoEvent = body.bucket === "important" && body.autoEvent === true;

    // 同じメールに対する学習例が既にあれば UPDATE (重複増殖防止)。
    // 1 メール = 1 学習例。最新の user 意図だけを残す。embedding は再計算しない
    // (embedded_text が変わるケースは無いので不要)。
    const [existing] = await db
      .select({ id: mailTrainingExamples.id })
      .from(mailTrainingExamples)
      .where(eq(mailTrainingExamples.sourceMailId, mail.id))
      .limit(1);

    let row: { id: number };
    if (existing) {
      const [updated] = await db
        .update(mailTrainingExamples)
        .set({
          bucket: body.bucket,
          hintText: body.hintText.trim().slice(0, 1000),
          autoTodo,
          autoEvent,
          updatedAt: new Date(),
        })
        .where(eq(mailTrainingExamples.id, existing.id))
        .returning({ id: mailTrainingExamples.id });
      row = updated;
    } else {
      // 新規例のみ embed を実行 (UPDATE 経路は embedding 再計算しないので節約)
      const embedding = await embed(embeddedText);
      const [inserted] = await db
        .insert(mailTrainingExamples)
        .values({
          sourceMailId: mail.id,
          embedding,
          embeddedText,
          bucket: body.bucket,
          hintText: body.hintText.trim().slice(0, 1000),
          autoTodo,
          autoEvent,
        })
        .returning({ id: mailTrainingExamples.id });
      row = inserted;
    }

    // 元 mail にもラベルを反映 (user の手動判定 = 信頼度 1.0)
    await db
      .update(mailMessages)
      .set({
        bucket: body.bucket,
        bucketConfidence: 1.0,
        bucketReason: body.hintText.trim().slice(0, 200),
        classifiedAt: new Date(),
      })
      .where(eq(mailMessages.id, mail.id));

    return NextResponse.json({ id: row.id, ok: true });
  } catch (e) {
    return clientError(req, e, { context: "mail-training", message: "学習例の登録に失敗しました" });
  }
}

export async function GET(req: NextRequest) {
  const limit = Math.min(parseInt(req.nextUrl.searchParams.get("limit") ?? "200", 10), 500);
  const rows = await db
    .select({
      id: mailTrainingExamples.id,
      sourceMailId: mailTrainingExamples.sourceMailId,
      bucket: mailTrainingExamples.bucket,
      hintText: mailTrainingExamples.hintText,
      embeddedText: mailTrainingExamples.embeddedText,
      autoTodo: mailTrainingExamples.autoTodo,
      autoEvent: mailTrainingExamples.autoEvent,
      createdAt: mailTrainingExamples.createdAt,
      updatedAt: mailTrainingExamples.updatedAt,
      // 元メール subject (元メール削除済なら null)
      sourceSubject: mailMessages.subject,
    })
    .from(mailTrainingExamples)
    .leftJoin(
      mailMessages,
      eq(mailTrainingExamples.sourceMailId, mailMessages.id)
    )
    .orderBy(desc(mailTrainingExamples.createdAt))
    .limit(limit);
  return NextResponse.json({ examples: rows });
}
