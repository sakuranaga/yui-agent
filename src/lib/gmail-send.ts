/**
 * Gmail 送信 / 下書き作成のラッパー。
 *
 * - users.messages.send  (scope: gmail.send)
 * - users.drafts.create  (scope: gmail.compose)
 *
 * RFC2822 形式の生メッセージを base64URL で送る。multipart は手動構築。
 * 自 server / 自 DB には送信内容を保存しない。
 *
 * 設計: docs/mail-system.md §6.2.5, §7.3
 */
import { getAccessTokenForEmail, googleCloudProject } from "@/lib/google-oauth";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

export type ComposeAttachment = {
  filename: string;
  mimeType: string;
  /** base64 (NOT URL-safe; raw base64 is fine since we wrap in MIME) */
  contentBase64: string;
};

export type ComposeInput = {
  fromEmail: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;                       // plain text
  inReplyToMessageId?: string;        // 元 Gmail message ID (返信時)
  inReplyToHeader?: string;           // 元の Message-ID ヘッダ (RFC2822) を入れる用
  references?: string;                // 元の References ヘッダ
  threadId?: string;                  // Gmail threadId (返信を同 thread に紐付け)
  attachments?: ComposeAttachment[];
};

/** URL-safe base64 (no padding) */
function toBase64Url(input: string | Buffer): string {
  const buf = typeof input === "string" ? Buffer.from(input, "utf-8") : input;
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * ヘッダ値の CRLF / NUL を除去 (= header injection 対策)。
 * RFC2822 ヘッダは CRLF が区切りなので、原文に CRLF が含まれると追加ヘッダを注入できる。
 * 攻撃例: To に "victim@x.com\r\nBcc: attacker@evil.com" を入れて密かに BCC 送信。
 */
function sanitizeHeader(v: string): string {
  return v.replace(/[\r\n\0]/g, "");
}

/**
 * RFC5321 ベースの簡易 email 構文検証。
 * 1 行 (= CRLF なし) で「local@domain」形式かを確認。display name 付き ("Name <a@b>")
 * もよくあるので、その場合は中身 email を抽出して検証。
 */
const EMAIL_RE = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
function validateEmailAddress(raw: string): string {
  const safe = sanitizeHeader(raw).trim();
  // "Display Name <email@example.com>" → email 部分だけ検証
  const angled = safe.match(/^.+<([^<>@\s]+@[^<>@\s]+)>\s*$/);
  const email = angled ? angled[1] : safe;
  if (!EMAIL_RE.test(email)) {
    throw new Error(`invalid email address: ${safe}`);
  }
  return safe;
}

/**
 * ファイル名の sanitize (= MIME header の `filename=` に補間するので CRLF + 引用符を弾く)。
 * Content-Disposition は filename パラメータ内で " をエスケープしないと終端誤認される。
 */
function sanitizeFilename(name: string): string {
  return sanitizeHeader(name).replace(/["\\]/g, "_");
}

/** MIME type も注入禁止 (= 開発者が任意値を入れた場合の保険) */
function sanitizeMimeType(mime: string): string {
  // type/subtype だけ許可、それ以外の文字は弾く
  const m = sanitizeHeader(mime).trim().match(/^([a-z0-9._+-]+\/[a-z0-9._+-]+)$/i);
  return m ? m[1] : "application/octet-stream";
}

/** RFC2822 形式の生メッセージを組み立てる */
function buildRawMessage(input: ComposeInput): string {
  const boundary = `----yui_boundary_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
  const headers: string[] = [];
  // header injection 対策: From/To/Cc/Bcc は必ず構文検証 + CRLF 除去
  headers.push(`From: ${validateEmailAddress(input.fromEmail)}`);
  headers.push(`To: ${input.to.map(validateEmailAddress).join(", ")}`);
  if (input.cc && input.cc.length > 0) headers.push(`Cc: ${input.cc.map(validateEmailAddress).join(", ")}`);
  if (input.bcc && input.bcc.length > 0) headers.push(`Bcc: ${input.bcc.map(validateEmailAddress).join(", ")}`);
  // 件名は MIME encode (UTF-8 + base64) なので CRLF は base64 化で無害化される
  const subjectEncoded = `=?UTF-8?B?${Buffer.from(input.subject, "utf-8").toString("base64")}?=`;
  headers.push(`Subject: ${subjectEncoded}`);
  headers.push(`MIME-Version: 1.0`);
  // In-Reply-To / References は <message-id> 形式、念のため CRLF 除去
  if (input.inReplyToHeader) headers.push(`In-Reply-To: ${sanitizeHeader(input.inReplyToHeader)}`);
  if (input.references) headers.push(`References: ${sanitizeHeader(input.references)}`);

  const hasAttachments = input.attachments && input.attachments.length > 0;
  if (!hasAttachments) {
    headers.push(`Content-Type: text/plain; charset=UTF-8`);
    headers.push(`Content-Transfer-Encoding: base64`);
    const bodyB64 = Buffer.from(input.body, "utf-8").toString("base64");
    // base64 は 76 文字 wrap
    const wrapped = bodyB64.match(/.{1,76}/g)?.join("\r\n") ?? bodyB64;
    return headers.join("\r\n") + "\r\n\r\n" + wrapped;
  }

  // multipart/mixed
  headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
  const parts: string[] = [];
  // body part
  parts.push(
    [
      `--${boundary}`,
      `Content-Type: text/plain; charset=UTF-8`,
      `Content-Transfer-Encoding: base64`,
      ``,
      Buffer.from(input.body, "utf-8").toString("base64").match(/.{1,76}/g)?.join("\r\n") ?? "",
    ].join("\r\n")
  );
  // attachments — ファイル名 / MIME type も sanitize
  for (const a of input.attachments ?? []) {
    const safeName = sanitizeFilename(a.filename);
    const safeMime = sanitizeMimeType(a.mimeType);
    const wrapped = a.contentBase64.match(/.{1,76}/g)?.join("\r\n") ?? a.contentBase64;
    parts.push(
      [
        `--${boundary}`,
        `Content-Type: ${safeMime}; name="${safeName}"`,
        `Content-Transfer-Encoding: base64`,
        `Content-Disposition: attachment; filename="${safeName}"`,
        ``,
        wrapped,
      ].join("\r\n")
    );
  }
  parts.push(`--${boundary}--`);

  return headers.join("\r\n") + "\r\n\r\n" + parts.join("\r\n");
}

async function postGmail<T>(
  email: string,
  path: string,
  payload: unknown
): Promise<T> {
  const token = await getAccessTokenForEmail(email);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const project = googleCloudProject();
  if (project) headers["X-Goog-User-Project"] = project;
  // eslint-disable-next-line no-restricted-syntax -- Gmail 公式 API (gmail.googleapis.com 固定)
  const res = await fetch(`${GMAIL_BASE}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

/** 送信。成功時 Gmail message id を返す。 */
export async function sendMail(input: ComposeInput): Promise<{ id: string; threadId?: string }> {
  const raw = toBase64Url(buildRawMessage(input));
  const payload: { raw: string; threadId?: string } = { raw };
  if (input.threadId) payload.threadId = input.threadId;
  return postGmail<{ id: string; threadId?: string }>(
    input.fromEmail,
    "/users/me/messages/send",
    payload
  );
}

/** 下書きを Gmail Drafts に保存。次の poll で逆流入する。 */
export async function createDraft(input: ComposeInput): Promise<{ id: string }> {
  const raw = toBase64Url(buildRawMessage(input));
  const message: { raw: string; threadId?: string } = { raw };
  if (input.threadId) message.threadId = input.threadId;
  const data = await postGmail<{ id: string; message?: { id: string } }>(
    input.fromEmail,
    "/users/me/drafts",
    { message }
  );
  return { id: data.id };
}
