/**
 * POST /api/mail/draft
 *   下書きを Gmail Drafts に保存。
 *   user の下書き保存 + Yui の compose_mail tool 両方からここを呼ぶ。
 *   gmail.compose scope だけで OK (送信権限は不要)。
 *
 * 設計: docs/mail-system.md §6.2.5, §7.3
 */
import { NextResponse, type NextRequest } from "next/server";
import { createDraft, type ComposeInput, type ComposeAttachment } from "@/lib/gmail-send";
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<ComposeInput> & {
      inReplyToDbId?: number;
    };
    if (!body.fromEmail) {
      return NextResponse.json({ error: "fromEmail 必須" }, { status: 400 });
    }

    let threadId: string | undefined = body.threadId;
    if (body.inReplyToDbId) {
      const [row] = await db
        .select({ gmailThreadId: mailMessages.gmailThreadId })
        .from(mailMessages)
        .where(eq(mailMessages.id, body.inReplyToDbId))
        .limit(1);
      if (row) threadId = row.gmailThreadId;
    }

    const attachments: ComposeAttachment[] | undefined =
      Array.isArray(body.attachments) && body.attachments.length > 0
        ? (body.attachments as ComposeAttachment[])
        : undefined;

    const result = await createDraft({
      fromEmail: body.fromEmail,
      to: Array.isArray(body.to) ? body.to.filter((s): s is string => typeof s === "string") : [],
      cc: body.cc?.filter((s): s is string => typeof s === "string"),
      bcc: body.bcc?.filter((s): s is string => typeof s === "string"),
      subject: typeof body.subject === "string" ? body.subject : "",
      body: typeof body.body === "string" ? body.body : "",
      threadId,
      attachments,
    });

    return NextResponse.json({ ok: true, draftId: result.id });
  } catch (e) {
    // 403 / scope 不足だけ client 側で再 grant 誘導するために分岐。それ以外は generic に丸める。
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("403") || msg.includes("insufficientPermissions")) {
      return clientError(req, e, {
        status: 403,
        context: "mail/draft",
        message: "Gmail 下書き保存の権限が不足しています。設定 > 連携 で Google を再連携してください。",
      });
    }
    return clientError(req, e, {
      context: "mail/draft",
      message: "下書きの保存に失敗しました",
    });
  }
}
