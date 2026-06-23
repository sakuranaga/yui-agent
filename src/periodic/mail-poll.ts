/**
 * mail-poll periodic: 10 分毎に全 enabled Gmail アカウントから header を pull。
 *
 * 設計: docs/mail-system.md §3, §4, §9.5
 *
 * Phase A: header のみ DB に保存、curation も UI もまだ。
 * - 初回 (last_synced_at IS NULL): 過去 initial_sync_days 日 (default 3)
 * - 以降:   last_synced_at の少し前から (重複は ON CONFLICT で弾く)
 * - 削除済 row は ON CONFLICT DO NOTHING で永続的に保護される
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import { db } from "@/db/client";
import { mailMessages, type NewMailMessage } from "@/db/schema";
import { listGmailAccounts, updateLastSyncedAt } from "@/lib/mail-accounts";
import { getAccessTokenForEmail, googleCloudProject } from "@/lib/google-oauth";
import { curateMails } from "@/lib/mail-curate";
import { fetchBodiesForMessages } from "@/lib/mail-body";
import { getMailCurationSettings } from "@/lib/mail-curation-settings";
import { broadcastMailInserted } from "@/lib/jobs/events";
import { dispatchNotification } from "@/lib/notifications";
import { gte, isNull, and, inArray } from "drizzle-orm";

// blocked リストに入っている送信者のメールは「そもそも DB に入れない」方針。
// ブロック = LLM にも渡さず、自 DB にも残らない (= 完全に存在しないかのように扱う)。
// 受信箱は再 poll でも空のまま、Gmail 側には残るので必要なら Gmail で開く。

const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1";
const MAX_MESSAGES_PER_POLL = 100;

type GmailListResponse = {
  messages?: Array<{ id: string; threadId: string }>;
  resultSizeEstimate?: number;
};

type GmailHeader = { name: string; value: string };
type GmailMetadataResponse = {
  id: string;
  threadId: string;
  snippet?: string;
  labelIds?: string[];
  internalDate?: string;
  payload?: { headers?: GmailHeader[] };
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
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Gmail ${path} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** "Foo <foo@example.com>" → { name: "Foo", email: "foo@example.com" } */
function parseFromAddress(raw: string | undefined): { name: string | null; email: string } {
  if (!raw) return { name: null, email: "" };
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || null, email: m[2].trim().toLowerCase() };
  // 括弧なし、email だけのケース
  return { name: null, email: raw.trim().toLowerCase() };
}

/** "a@x.com, b@y.com" → ["a@x.com", "b@y.com"] */
function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const mailPoll: PeriodicModule = {
  id: "mail-poll",
  enabled: true,
  schedule: { kind: "interval", everyMs: 10 * 60_000 }, // 10 分
  run: async (ctx: PeriodicContext): Promise<PeriodicResult> => {
    const accounts = await listGmailAccounts({ enabledOnly: true });
    if (accounts.length === 0) {
      return { skip: true, reason: "no enabled accounts" };
    }

    // blocked リストを最初に取得して全アカウントで共有 (mutate しない)
    const initialSettings = await getMailCurationSettings();
    const blockedSet = new Set(initialSettings.blockedAddresses.map((e) => e.toLowerCase()));

    let totalFetched = 0;
    let totalInserted = 0;
    let totalBlocked = 0;
    const allInsertedIds: number[] = [];
    const errors: string[] = [];

    // アカウント並列処理 (それぞれ独立に失敗しても他は進める)
    await Promise.allSettled(
      accounts.map(async (acc) => {
        try {
          // 同期範囲: 初回 = 過去 initial_sync_days 日、以降 = last_synced_at の 1 日前から
          // (Gmail の internalDate がローカル時刻と微妙にずれることを許容するため少しオーバラップ)
          const sinceDate = acc.lastSyncedAt
            ? new Date(acc.lastSyncedAt.getTime() - 24 * 60 * 60_000)
            : new Date(Date.now() - acc.initialSyncDays * 24 * 60 * 60_000);
          const sinceEpoch = Math.floor(sinceDate.getTime() / 1000);

          // 受信メール (INBOX) + 送信メール (SENT) を順に取る
          // Sent も逆流入で「送信箱」として表示するため
          for (const labelId of ["INBOX", "SENT"]) {
            const list = await callGmail<GmailListResponse>(acc.email, "/users/me/messages", {
              q: `after:${sinceEpoch}`,
              maxResults: String(MAX_MESSAGES_PER_POLL),
              labelIds: labelId,
            });
            const refs = list.messages ?? [];
            totalFetched += refs.length;

            // metadata 並列取得 (5 件ずつ chunk して quota 配慮)
            const CHUNK = 5;
            const rows: NewMailMessage[] = [];
            for (let i = 0; i < refs.length; i += CHUNK) {
              const slice = refs.slice(i, i + CHUNK);
              const metas = await Promise.all(
                slice.map(async (r) => {
                  try {
                    return await callGmail<GmailMetadataResponse>(
                      acc.email,
                      `/users/me/messages/${encodeURIComponent(r.id)}`,
                      {
                        format: "metadata",
                        metadataHeaders: ["From", "To", "Subject", "Date"],
                      }
                    );
                  } catch (e) {
                    console.warn(`[mail-poll] ${acc.email} get ${r.id} failed:`, e);
                    return null;
                  }
                })
              );
              for (const m of metas) {
                if (!m) continue;
                const headers = new Map(
                  (m.payload?.headers ?? []).map((h) => [h.name.toLowerCase(), h.value])
                );
                const fromRaw = headers.get("from");
                const from = parseFromAddress(fromRaw);
                if (!from.email) continue;
                // blocked リスト hit → DB に入れない (LLM 判定もしない)
                if (blockedSet.has(from.email)) {
                  totalBlocked++;
                  continue;
                }
                const receivedAt = m.internalDate
                  ? new Date(parseInt(m.internalDate, 10))
                  : new Date();
                rows.push({
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
            }

            if (rows.length === 0) continue;

            // ON CONFLICT (gmail_message_id, account_id) DO NOTHING:
            //   - 既存 row (deleted_at が立ってるもの含む) は触らない = 削除済の復活を防ぐ
            //   - これが「自 DB で消したら再同期しない」の保証点
            const inserted = await db
              .insert(mailMessages)
              .values(rows)
              .onConflictDoNothing({
                target: [mailMessages.gmailMessageId, mailMessages.accountId],
              })
              .returning({ id: mailMessages.id });
            totalInserted += inserted.length;
            for (const r of inserted) allInsertedIds.push(r.id);
            if (inserted.length > 0) broadcastMailInserted(inserted.length);
          }

          await updateLastSyncedAt(acc.id);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.warn(`[mail-poll] ${acc.email} failed:`, msg);
          errors.push(`${acc.email}: ${msg}`);
        }
      })
    );

    console.log(
      `[mail-poll] accounts=${accounts.length} fetched=${totalFetched} inserted=${totalInserted} blocked_skipped=${totalBlocked} errors=${errors.length}`
    );

    // 新規 row があれば curate を回す (失敗しても周期処理は止めない)
    let bodyFetched = 0;
    if (allInsertedIds.length > 0) {
      try {
        await curateMails(allInsertedIds);
      } catch (e) {
        console.warn("[mail-poll] curate batch failed:", e);
      }

      // 閾値超えになった新着分の本文を preemptive fetch (UI 即表示できるように)
      try {
        const settings = await getMailCurationSettings();
        const passing = await db
          .select({ id: mailMessages.id })
          .from(mailMessages)
          .where(
            and(
              inArray(mailMessages.id, allInsertedIds),
              gte(mailMessages.score, settings.scoreThreshold),
              isNull(mailMessages.bodyFetchedAt)
            )
          );
        if (passing.length > 0) {
          const r = await fetchBodiesForMessages(passing.map((p) => p.id));
          bodyFetched = r.fetched;
        }
      } catch (e) {
        console.warn("[mail-poll] body fetch failed:", e);
      }

      // 通知 dispatch: 閾値超えの新着メールを bucket に応じて mail_important / mail_other で投げる。
      // important = 「人間からの直接連絡 / 緊急 / 契約 / 顧客先からの返信」等 (mail-curate.ts §63 参照)。
      // それ以外 (needed / 上位 unneeded で閾値超えたもの) は mail_other で toast のみが基本。
      // 設計: docs/notification-system.md §6
      try {
        const settings = await getMailCurationSettings();
        const passingRows = await db
          .select({
            id: mailMessages.id,
            subject: mailMessages.subject,
            fromName: mailMessages.fromName,
            fromEmail: mailMessages.fromEmail,
            bucket: mailMessages.bucket,
            labels: mailMessages.labels,
          })
          .from(mailMessages)
          .where(
            and(
              inArray(mailMessages.id, allInsertedIds),
              gte(mailMessages.score, settings.scoreThreshold)
            )
          );
        for (const m of passingRows) {
          // 送信メール (SENT) は通知しない (= 自分が送ったメールは知ってる)
          if (m.labels && m.labels.includes("SENT")) continue;
          const isImportant = m.bucket === "important";
          const senderLabel = m.fromName ?? m.fromEmail ?? "";
          const subj = m.subject ?? "(件名なし)";
          // title に「メール」prefix を必ず付ける (= toast 一覧でメール起因と即分かるように)
          const titlePrefix = isImportant ? "重要メール" : "メール";
          try {
            await dispatchNotification({
              sessionId: ctx.sessionId,
              kind: isImportant ? "mail_important" : "mail_other",
              importance: isImportant ? "high" : "normal",
              title: `${titlePrefix}: ${subj}`,
              preview: senderLabel ? `${senderLabel} さんから` : undefined,
              // bodyMd には本文を入れない (= privacy)。replay 時に別途取得
              payload: { from_email: m.fromEmail, bucket: m.bucket },
              refTable: "mail_messages",
              refId: m.id,
              speakText: isImportant
                ? `${senderLabel} さんから重要メールが届いてますよ。件名は「${subj}」です。`
                : `${senderLabel} さんからメールが届きました。`,
            });
          } catch (e) {
            console.warn(`[mail-poll] dispatch failed for mail ${m.id}:`, e);
          }
        }
      } catch (e) {
        console.warn("[mail-poll] notification dispatch failed:", e);
      }
    }

    return {
      skip: true,
      reason: `inserted ${totalInserted}/${totalFetched} curated=${allInsertedIds.length} body=${bodyFetched} (${errors.length} errors)`,
    };
  },
};

export default mailPoll;
