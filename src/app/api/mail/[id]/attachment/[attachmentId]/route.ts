/**
 * GET /api/mail/<id>/attachment/<attachmentId>
 *   Gmail から添付実体を都度 fetch してブラウザに stream。
 *   自 server / 自 DB には保存しない (セキュリティ + Gmail を SoT として尊重)。
 */
import { type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages, mailAttachments, gmailAccounts } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { getAccessTokenForEmail, googleCloudProject } from "@/lib/google-oauth";
import { clientError } from "@/lib/api-error";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

export const dynamic = "force-dynamic";

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string; attachmentId: string }> }
) {
  const { id, attachmentId } = await params;
  const msgId = parseInt(id, 10);
  const attId = parseInt(attachmentId, 10);
  if (!Number.isFinite(msgId) || !Number.isFinite(attId)) {
    return new Response("invalid id", { status: 400 });
  }

  try {
    // メッセージ + 添付メタ + アカウント email を引く
    const [row] = await db
      .select({
        gmailMessageId: mailMessages.gmailMessageId,
        accountEmail: gmailAccounts.email,
        filename: mailAttachments.filename,
        mimeType: mailAttachments.mimeType,
        gmailPartId: mailAttachments.gmailPartId,
      })
      .from(mailAttachments)
      .innerJoin(mailMessages, eq(mailAttachments.messageId, mailMessages.id))
      .innerJoin(gmailAccounts, eq(mailMessages.accountId, gmailAccounts.id))
      .where(and(eq(mailAttachments.id, attId), eq(mailMessages.id, msgId)))
      .limit(1);

    if (!row || !row.gmailPartId) {
      return new Response("not found", { status: 404 });
    }

    // Gmail attachment endpoint: GET /users/me/messages/<msgId>/attachments/<partId>
    const token = await getAccessTokenForEmail(row.accountEmail);
    const url = new URL(
      `${GMAIL_BASE}/users/me/messages/${encodeURIComponent(row.gmailMessageId)}/attachments/${encodeURIComponent(row.gmailPartId)}`
    );
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    const project = googleCloudProject();
    if (project) headers["X-Goog-User-Project"] = project;

    // eslint-disable-next-line no-restricted-syntax -- Gmail 公式 API (gmail.googleapis.com 固定、添付ファイル取得)
    const res = await fetch(url.toString(), {
      headers,
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return new Response(`upstream ${res.status}: ${text.slice(0, 200)}`, { status: 502 });
    }
    const json = (await res.json()) as { data?: string; size?: number };
    if (!json.data) {
      return new Response("no attachment data", { status: 502 });
    }
    // URL-safe base64 → Buffer
    const b64 = json.data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
    const pad = b64.length % 4 === 0 ? b64 : b64 + "=".repeat(4 - (b64.length % 4));
    const buf = Buffer.from(pad, "base64");

    return new Response(buf as unknown as BodyInit, {
      status: 200,
      headers: {
        "Content-Type": row.mimeType ?? "application/octet-stream",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(row.filename)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    return clientError(req, e, {
      context: "mail/attachment GET",
      message: "添付ファイルの取得に失敗しました",
    });
  }
}
