/**
 * POST /api/mail/poll
 *   手動で mail-poll periodic と同等の処理を即時実行。
 *   MailModal の「再読込」ボタンから呼ばれる。
 *   - 全 enabled accounts から新着を fetch
 *   - blocked 除外 + DB INSERT
 *   - 新規分を Gemma で curate
 *   - 閾値超え分の body を fetch
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { mailMessages, type NewMailMessage } from "@/db/schema";
import { and, eq, gte, inArray, isNull } from "drizzle-orm";
import { listGmailAccounts, updateLastSyncedAt } from "@/lib/mail-accounts";
import { getAccessTokenForEmail, googleCloudProject } from "@/lib/google-oauth";
import { curateMails } from "@/lib/mail-curate";
import { fetchBodiesForMessages } from "@/lib/mail-body";
import { getMailCurationSettings } from "@/lib/mail-curation-settings";
import { broadcastMailInserted } from "@/lib/jobs/events";

export const dynamic = "force-dynamic";

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const MAX_PER_POLL = 100;

type GmailListResp = { messages?: Array<{ id: string; threadId: string }> };
type GmailMetaResp = {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: Array<{ name: string; value: string }> };
};

async function callGmail<T>(email: string, path: string, query?: Record<string, string | string[]>): Promise<T> {
  const token = await getAccessTokenForEmail(email);
  const url = new URL(`${GMAIL_BASE}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) {
      if (Array.isArray(v)) for (const item of v) url.searchParams.append(k, item);
      else url.searchParams.set(k, v);
    }
  }
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const project = googleCloudProject();
  if (project) headers["X-Goog-User-Project"] = project;
  // eslint-disable-next-line no-restricted-syntax -- Gmail 公式 API (gmail.googleapis.com 固定)
  const res = await fetch(url.toString(), { headers, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`Gmail ${path} → ${res.status}`);
  return (await res.json()) as T;
}

function parseFromAddress(raw: string | undefined): { name: string | null; email: string } {
  if (!raw) return { name: null, email: "" };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  return { name: null, email: raw.trim().toLowerCase() };
}
function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

export async function POST() {
  const accounts = await listGmailAccounts({ enabledOnly: true });
  if (accounts.length === 0) {
    return NextResponse.json({ ok: true, fetched: 0, inserted: 0, message: "no enabled accounts" });
  }
  const settings0 = await getMailCurationSettings();
  const blockedSet = new Set(settings0.blockedAddresses.map((e) => e.toLowerCase()));

  let totalFetched = 0;
  let totalInserted = 0;
  let totalBlocked = 0;
  const insertedIds: number[] = [];
  const errors: string[] = [];

  await Promise.allSettled(
    accounts.map(async (acc) => {
      try {
        const sinceDate = acc.lastSyncedAt
          ? new Date(acc.lastSyncedAt.getTime() - 24 * 60 * 60_000)
          : new Date(Date.now() - acc.initialSyncDays * 24 * 60 * 60_000);
        const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);

        for (const labelId of ["INBOX", "SENT"]) {
          const list = await callGmail<GmailListResp>(acc.email, "/users/me/messages", {
            q: `after:${sinceEpoch}`,
            maxResults: String(MAX_PER_POLL),
            labelIds: labelId,
          });
          const refs = list.messages ?? [];
          totalFetched += refs.length;

          const CHUNK = 5;
          for (let i = 0; i < refs.length; i += CHUNK) {
            const slice = refs.slice(i, i + CHUNK);
            const metas = await Promise.all(
              slice.map((r) =>
                callGmail<GmailMetaResp>(acc.email, `/users/me/messages/${encodeURIComponent(r.id)}`, {
                  format: "metadata",
                  metadataHeaders: ["From", "To", "Subject", "Date"],
                }).catch(() => null)
              )
            );
            const chunkRows: NewMailMessage[] = [];
            for (const m of metas) {
              if (!m) continue;
              const headers = new Map((m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value]));
              const fromRaw = headers.get("from");
              const from = parseFromAddress(fromRaw);
              if (!from.email) continue;
              if (blockedSet.has(from.email)) {
                totalBlocked++;
                continue;
              }
              const receivedAt = m.internalDate ? new Date(parseInt(m.internalDate, 10)) : new Date();
              chunkRows.push({
                gmailMessageId: m.id,
                gmailThreadId: m.threadId,
                accountId: acc.id,
                fromAddress: fromRaw ?? from.email,
                fromName: from.name,
                fromEmail: from.email,
                toAddresses: parseAddressList(headers.get("to")),
                subject: headers.get("subject") ?? null,
                snippet: m.snippet ?? "",
                receivedAt,
                labels: m.labelIds ?? [],
              });
            }
            // チャンクごとに即時 INSERT して SSE で MailModal に通知
            if (chunkRows.length > 0) {
              const inserted = await db
                .insert(mailMessages)
                .values(chunkRows)
                .onConflictDoNothing({ target: [mailMessages.gmailMessageId, mailMessages.accountId] })
                .returning({ id: mailMessages.id });
              totalInserted += inserted.length;
              for (const r of inserted) insertedIds.push(r.id);
              if (inserted.length > 0) broadcastMailInserted(inserted.length);
            }
          }
        }
        await updateLastSyncedAt(acc.id);
      } catch (e) {
        // 詳細は server log に出す。client response の errors[] には Gmail API の生メッセージ /
        // OAuth token error / DB driver 例外をそのまま乗せず、固定の人間向け文だけにする。
        console.warn(`[mail/poll] account sync failed (${acc.email}):`, e);
        errors.push(`${acc.email}: メール取得に失敗しました`);
      }
    })
  );

  let bodyFetched = 0;
  if (insertedIds.length > 0) {
    try {
      await curateMails(insertedIds);
    } catch (e) {
      console.warn("[mail/poll] curate failed:", e);
      errors.push("curate: メール分類に失敗しました");
    }
    try {
      const settings = await getMailCurationSettings();
      const passing = await db
        .select({ id: mailMessages.id })
        .from(mailMessages)
        .where(
          and(
            inArray(mailMessages.id, insertedIds),
            gte(mailMessages.score, settings.scoreThreshold),
            isNull(mailMessages.bodyFetchedAt)
          )
        );
      if (passing.length > 0) {
        const r = await fetchBodiesForMessages(passing.map((p) => p.id));
        bodyFetched = r.fetched;
      }
    } catch (e) {
      console.warn("[mail/poll] body fetch failed:", e);
      errors.push("body: 本文取得に失敗しました");
    }
  }
  void eq; // import 維持

  return NextResponse.json({
    ok: true,
    fetched: totalFetched,
    inserted: totalInserted,
    blocked: totalBlocked,
    bodyFetched,
    errors,
  });
}
