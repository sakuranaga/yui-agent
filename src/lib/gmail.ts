/**
 * Gmail v1 REST client (薄いラッパ、readonly)。
 *
 * Yui の mail_specialist の各 tool handler から呼ばれる。
 * 現在の scope は gmail.readonly のみなので read 系のみ提供。
 * 後で送信が必要になったら gmail.send scope 追加 + sendMessage 関数を増やす。
 */
import { getAccessTokenForMcp, googleCloudProject } from "./google-oauth";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";

export function isGmailConfigured(): boolean {
  return !!process.env.GOOGLE_CLIENT_ID && !!process.env.GOOGLE_CLIENT_SECRET;
}

async function authHeaders(): Promise<Record<string, string>> {
  const token = await getAccessTokenForMcp();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  const project = googleCloudProject();
  if (project) headers["X-Goog-User-Project"] = project;
  return headers;
}

async function callJson<T>(
  method: string,
  path: string,
  query?: Record<string, string | number | string[] | undefined>
): Promise<T> {
  const url = new URL(`${GMAIL_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null || v === "") continue;
      if (Array.isArray(v)) {
        // 配列パラメータ (例: metadataHeaders) は append で複数回送る
        for (const item of v) url.searchParams.append(k, String(item));
      } else {
        url.searchParams.set(k, String(v));
      }
    }
  }
  const headers = await authHeaders();
  // eslint-disable-next-line no-restricted-syntax -- Gmail 公式 API (https://gmail.googleapis.com 固定)
  const res = await fetch(url.toString(), { method, headers });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail API ${method} ${path} → ${res.status}: ${text.slice(0, 400)}`);
  }
  return (await res.json()) as T;
}

// --- Types ---

export type GmailMessageRef = {
  id: string;
  threadId: string;
};

export type GmailLabel = {
  id: string;
  name: string;
  type?: "system" | "user";
  messagesUnread?: number;
  messagesTotal?: number;
};

export type GmailHeader = { name: string; value: string };

export type GmailMessageSummary = {
  id: string;
  threadId: string;
  snippet: string;
  labelIds: string[];
  internalDate: string; // ms epoch as string
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
};

// --- API ---

/** メール検索 (Gmail Search Query syntax: "is:unread", "from:foo", "after:2026/05/20" 等) */
export async function listMessages(opts: {
  q?: string;
  maxResults?: number;
  labelIds?: string[];
}): Promise<{ messages: GmailMessageRef[]; resultSizeEstimate: number }> {
  type Resp = { messages?: GmailMessageRef[]; resultSizeEstimate?: number };
  const data = await callJson<Resp>("GET", "/users/me/messages", {
    q: opts.q,
    maxResults: opts.maxResults ?? 10,
    labelIds: opts.labelIds?.join(","),
  });
  return {
    messages: data.messages ?? [],
    resultSizeEstimate: data.resultSizeEstimate ?? 0,
  };
}

/**
 * メッセージ詳細を取得。format=metadata で header だけ抜く軽量版。
 * 本文 (snippet) も同時に取れる。
 */
export async function getMessageMetadata(messageId: string): Promise<GmailMessageSummary> {
  type Resp = {
    id: string;
    threadId: string;
    snippet: string;
    labelIds: string[];
    internalDate: string;
    payload?: { headers?: GmailHeader[] };
  };
  const data = await callJson<Resp>(
    "GET",
    `/users/me/messages/${encodeURIComponent(messageId)}`,
    {
      format: "metadata",
      // 配列で送る (Gmail は repeated parameter として期待。カンマ区切り 1 string は無視される)
      metadataHeaders: ["From", "To", "Subject", "Date"],
    }
  );
  const headers = data.payload?.headers ?? [];
  const headerMap = new Map<string, string>(
    headers.map((h) => [h.name.toLowerCase(), h.value])
  );
  return {
    id: data.id,
    threadId: data.threadId,
    snippet: data.snippet ?? "",
    labelIds: data.labelIds ?? [],
    internalDate: data.internalDate,
    from: headerMap.get("from"),
    to: headerMap.get("to"),
    subject: headerMap.get("subject"),
    date: headerMap.get("date"),
  };
}

/**
 * 検索 → 各メッセージの metadata を並列取得 → 整形した配列を返す高水準ヘルパ。
 * specialist の tool 呼び出しを 1 回で済ませるため。
 */
export async function searchMessageSummaries(opts: {
  q?: string;
  maxResults?: number;
}): Promise<GmailMessageSummary[]> {
  const { messages } = await listMessages({
    q: opts.q,
    maxResults: opts.maxResults ?? 10,
  });
  if (messages.length === 0) return [];
  const summaries = await Promise.all(
    messages.map((m) => getMessageMetadata(m.id).catch((e) => {
      console.warn("[gmail] getMessageMetadata failed for", m.id, e);
      return null;
    }))
  );
  return summaries.filter((s): s is GmailMessageSummary => s !== null);
}

/** Label 一覧 (フィルタ用: ユーザー定義ラベル ID を引きたい時) */
export async function listLabels(): Promise<GmailLabel[]> {
  type Resp = { labels?: GmailLabel[] };
  const data = await callJson<Resp>("GET", "/users/me/labels");
  return data.labels ?? [];
}
