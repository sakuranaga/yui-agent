/**
 * POST /api/mail/send
 *   body: { fromEmail, to[], cc?[], bcc?[], subject, body,
 *           inReplyToMessageId?, threadId?, attachments? }
 *   ご主人様の明示クリックでのみ呼ばれる送信 endpoint。
 *   **Yui の tool からは呼ばれない** (gmail.send 権限は user UI 経由のみ)。
 *
 * 設計: docs/mail-system.md §6.2.5 「送信は必ず user」
 */
import { NextResponse, type NextRequest } from "next/server";
import { sendMail, type ComposeInput, type ComposeAttachment } from "@/lib/gmail-send";
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { loadTokenByEmail } from "@/lib/google-oauth";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<ComposeInput> & {
      inReplyToDbId?: number;
    };

    if (!body.fromEmail || !Array.isArray(body.to) || body.to.length === 0) {
      return NextResponse.json(
        { error: "fromEmail と to は必須" },
        { status: 400 }
      );
    }
    if (typeof body.subject !== "string" || typeof body.body !== "string") {
      return NextResponse.json(
        { error: "subject と body は必須" },
        { status: 400 }
      );
    }
    // fromEmail が「連携済 Google account の 1 つ」であることを必ず照合する。
    // 旧コードは client 指定の fromEmail を信頼していたので、攻撃者が任意 email を
    // 名乗って「所有者から送信した」体裁を作れる経路があった。
    // 連携済 account の token が見つかれば送信可、無ければ 403。
    const ownedToken = await loadTokenByEmail(body.fromEmail);
    if (!ownedToken) {
      return NextResponse.json(
        { error: `fromEmail "${body.fromEmail}" は連携済 Google アカウントではありません` },
        { status: 403 }
      );
    }

    // 返信時の Message-ID / References を元メール DB から引く
    let inReplyToHeader: string | undefined;
    let references: string | undefined;
    let threadId: string | undefined = body.threadId;
    let inReplyToMessageId: string | undefined = body.inReplyToMessageId;

    if (body.inReplyToDbId) {
      const [row] = await db
        .select({
          gmailMessageId: mailMessages.gmailMessageId,
          gmailThreadId: mailMessages.gmailThreadId,
        })
        .from(mailMessages)
        .where(eq(mailMessages.id, body.inReplyToDbId))
        .limit(1);
      if (row) {
        inReplyToMessageId = row.gmailMessageId;
        threadId = row.gmailThreadId;
        // Gmail message ID をそのまま Message-ID 形式に擬似変換は厳密には別。
        // ここは threadId で thread 紐付けに頼り、In-Reply-To は省略可。
      }
    }

    const attachments: ComposeAttachment[] | undefined =
      Array.isArray(body.attachments) && body.attachments.length > 0
        ? (body.attachments as ComposeAttachment[])
        : undefined;

    const result = await sendMail({
      fromEmail: body.fromEmail,
      to: body.to.filter((s): s is string => typeof s === "string"),
      cc: body.cc?.filter((s): s is string => typeof s === "string"),
      bcc: body.bcc?.filter((s): s is string => typeof s === "string"),
      subject: body.subject,
      body: body.body,
      inReplyToMessageId,
      inReplyToHeader,
      references,
      threadId,
      attachments,
    });

    return NextResponse.json({ ok: true, id: result.id, threadId: result.threadId });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // gmail.send scope 不足の場合、403 が返る。UI 側で再 grant を案内する。
    // 403 だけは client が判別する必要があるので明示的に分岐、それ以外は generic error
    // (= 上流の生 message を漏らさない)。
    if (msg.includes("403") || msg.includes("insufficientPermissions")) {
      const { clientError } = await import("@/lib/api-error");
      return clientError(req, e, {
        status: 403,
        message: "Gmail 送信権限が不足しています。設定 > 連携 で Google を再連携してください。",
        context: "mail/send",
      });
    }
    const { clientError } = await import("@/lib/api-error");
    return clientError(req, e, {
      status: 500,
      message: "メール送信に失敗しました。サーバログを確認してください。",
      context: "mail/send",
    });
  }
}
