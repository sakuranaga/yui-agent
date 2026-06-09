/**
 * 閾値超えメールの本文 + 添付メタを Gmail API (format=full) から取得して
 * mail_messages.body_text / body_html / body_fetched_at に保存。
 * 添付メタは mail_attachments に INSERT (実体は保存しない)。
 *
 * 設計: docs/mail-system.md §4, §5.6
 */
import { db } from "@/db/client";
import { mailMessages, mailAttachments, gmailAccounts } from "@/db/schema";
import { eq, inArray, and } from "drizzle-orm";
import { getAccessTokenForEmail, googleCloudProject } from "@/lib/google-oauth";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

type GmailPart = {
  partId?: string;
  mimeType?: string;
  filename?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { size?: number; attachmentId?: string; data?: string };
  parts?: GmailPart[];
};

type GmailFullMessage = {
  id: string;
  threadId: string;
  payload?: GmailPart;
};

/** URL-safe base64 → UTF-8 string */
function decodeB64Url(data: string): string {
  // 改行を除いて - / _ を + / / に戻す
  const b64 = data.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "");
  // padding を補う
  const pad = b64.length % 4;
  const padded = pad === 0 ? b64 : b64 + "=".repeat(4 - pad);
  return Buffer.from(padded, "base64").toString("utf-8");
}

type Extracted = {
  text: string | null;
  html: string | null;
  attachments: Array<{
    filename: string;
    mimeType: string | null;
    size: number | null;
    partId: string | null;
  }>;
};

/** payload tree を walk して text/plain, text/html, 添付を抜き出す */
function walkPayload(part: GmailPart | undefined, out: Extracted): void {
  if (!part) return;
  const mime = (part.mimeType ?? "").toLowerCase();
  const filename = part.filename ?? "";
  const dataBuf = part.body?.data;

  if (filename && filename.length > 0) {
    // 添付候補
    out.attachments.push({
      filename,
      mimeType: part.mimeType ?? null,
      size: part.body?.size ?? null,
      partId: part.partId ?? null,
    });
  } else if (mime === "text/plain" && dataBuf) {
    if (!out.text) out.text = decodeB64Url(dataBuf);
  } else if (mime === "text/html" && dataBuf) {
    if (!out.html) out.html = decodeB64Url(dataBuf);
  }

  if (part.parts) {
    for (const p of part.parts) walkPayload(p, out);
  }
}

async function callGmailFull(email: string, messageId: string): Promise<GmailFullMessage> {
  const token = await getAccessTokenForEmail(email);
  const url = new URL(`${GMAIL_BASE}/users/me/messages/${encodeURIComponent(messageId)}`);
  url.searchParams.set("format", "full");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const project = googleCloudProject();
  if (project) headers["X-Goog-User-Project"] = project;
  // eslint-disable-next-line no-restricted-syntax -- Gmail 公式 API (gmail.googleapis.com 固定)
  const res = await fetch(url.toString(), {
    headers,
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail full ${messageId} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as GmailFullMessage;
}

/**
 * 指定 mail_messages.id の row 群について body を Gmail から fetch して
 * DB に保存する。
 * - 既に body_fetched_at が立ってる row は skip
 * - 失敗は warn ログのみ (周期処理は止めない)
 */
export async function fetchBodiesForMessages(messageIds: number[]): Promise<{ fetched: number }> {
  if (messageIds.length === 0) return { fetched: 0 };

  // 対象 row + account email を join 取得
  const rows = await db
    .select({
      id: mailMessages.id,
      gmailMessageId: mailMessages.gmailMessageId,
      bodyFetchedAt: mailMessages.bodyFetchedAt,
      accountEmail: gmailAccounts.email,
    })
    .from(mailMessages)
    .innerJoin(gmailAccounts, eq(mailMessages.accountId, gmailAccounts.id))
    .where(inArray(mailMessages.id, messageIds));

  let fetched = 0;
  // 並列度を抑えめに (Gmail API は per-user quota 5 unit/req)
  const CONCURRENCY = 3;
  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    const batch = rows.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (r) => {
        if (r.bodyFetchedAt) return; // 既に取得済
        try {
          const msg = await callGmailFull(r.accountEmail, r.gmailMessageId);
          const out: Extracted = { text: null, html: null, attachments: [] };
          walkPayload(msg.payload, out);

          await db
            .update(mailMessages)
            .set({
              bodyText: out.text,
              bodyHtml: out.html,
              bodyFetchedAt: new Date(),
            })
            .where(eq(mailMessages.id, r.id));

          if (out.attachments.length > 0) {
            // 既存添付があれば削除 (重複防止)、その後 INSERT
            await db.delete(mailAttachments).where(eq(mailAttachments.messageId, r.id));
            await db.insert(mailAttachments).values(
              out.attachments.map((a) => ({
                messageId: r.id,
                filename: a.filename,
                mimeType: a.mimeType,
                sizeBytes: a.size,
                gmailPartId: a.partId,
              }))
            );
          }
          fetched++;
        } catch (e) {
          console.warn(`[mail-body] fetch ${r.id} (${r.gmailMessageId}) failed:`, e);
        }
      })
    );
  }
  void and; // import 維持
  return { fetched };
}
