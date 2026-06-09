/**
 * POST /api/mail/<id>/reply-draft
 *   body: { intent: "agree" | "decline" | "hold" | "ack", hint?: string }
 *   → { body: string }
 *   元メール DB id から context を引いて Sonnet で返信本文をドラフト。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateReply, type ReplyIntent } from "@/lib/mail-draft";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const VALID_INTENTS: ReplyIntent[] = ["agree", "decline", "hold", "ack"];

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as { intent?: string; hint?: string };
    const intent = body.intent as ReplyIntent;
    if (!VALID_INTENTS.includes(intent)) {
      return NextResponse.json({ error: "invalid intent" }, { status: 400 });
    }

    const [row] = await db
      .select({
        fromName: mailMessages.fromName,
        fromEmail: mailMessages.fromEmail,
        subject: mailMessages.subject,
        bodyText: mailMessages.bodyText,
        snippet: mailMessages.snippet,
      })
      .from(mailMessages)
      .where(eq(mailMessages.id, numId))
      .limit(1);
    if (!row) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const originalBody = row.bodyText && row.bodyText.length > 0
      ? row.bodyText
      : row.snippet ?? "";

    const replyBody = await generateReply({
      intent,
      original: {
        fromName: row.fromName,
        fromEmail: row.fromEmail,
        subject: row.subject,
        body: originalBody,
      },
      hint: typeof body.hint === "string" ? body.hint : undefined,
    });

    return NextResponse.json({ body: replyBody });
  } catch (e) {
    return clientError(req, e, { context: "mail/[id]/reply-draft", message: "返信ドラフトの生成に失敗しました" });
  }
}
