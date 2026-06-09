/**
 * gmail_accounts CRUD + primary 解決ヘルパー。
 *
 * 設計: docs/mail-system.md §4.1
 *
 * 既存 google_oauth_tokens (account_email UNIQUE) と email でリンクされる。
 * mail 機能で使うアカウントだけここに登録 (= OAuth 接続済みアカウントの subset)。
 */
import { db } from "@/db/client";
import { gmailAccounts, type GmailAccount } from "@/db/schema";
import { eq, asc } from "drizzle-orm";

/** 全アカウントを返す (display 順) */
export async function listGmailAccounts(opts?: {
  enabledOnly?: boolean;
}): Promise<GmailAccount[]> {
  const rows = await db
    .select()
    .from(gmailAccounts)
    .orderBy(asc(gmailAccounts.id));
  if (opts?.enabledOnly) return rows.filter((r) => r.enabled);
  return rows;
}

export async function getGmailAccountByEmail(email: string): Promise<GmailAccount | null> {
  const [row] = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.email, email))
    .limit(1);
  return row ?? null;
}

export async function getGmailAccountById(id: number): Promise<GmailAccount | null> {
  const [row] = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.id, id))
    .limit(1);
  return row ?? null;
}

/** primary アカウント (新規作成時の default from) */
export async function getPrimaryGmailAccount(): Promise<GmailAccount | null> {
  const [row] = await db
    .select()
    .from(gmailAccounts)
    .where(eq(gmailAccounts.isPrimary, true))
    .limit(1);
  return row ?? null;
}

/**
 * メール機能でアカウントを使い始めるとき呼ぶ。
 * - email が既存 → 何もしない (enabled 状態は保持)
 * - 新規 → INSERT。最初のアカウントは自動的に is_primary=true
 */
export async function ensureGmailAccount(email: string, displayName?: string): Promise<GmailAccount> {
  const existing = await getGmailAccountByEmail(email);
  if (existing) return existing;

  const all = await listGmailAccounts();
  const isFirst = all.length === 0;

  const [row] = await db
    .insert(gmailAccounts)
    .values({
      email,
      displayName: displayName ?? null,
      enabled: true,
      isPrimary: isFirst,
    })
    .returning();
  return row;
}

export async function setEnabled(id: number, enabled: boolean): Promise<void> {
  await db.update(gmailAccounts).set({ enabled }).where(eq(gmailAccounts.id, id));
}

/** 別のアカウントを primary にする (旧 primary は false に落とす) */
export async function setPrimary(id: number): Promise<void> {
  // partial unique index があるので、まず全部 false にしてから 1 つ true
  await db.update(gmailAccounts).set({ isPrimary: false });
  await db.update(gmailAccounts).set({ isPrimary: true }).where(eq(gmailAccounts.id, id));
}

export async function updateLastSyncedAt(id: number, at: Date = new Date()): Promise<void> {
  await db.update(gmailAccounts).set({ lastSyncedAt: at }).where(eq(gmailAccounts.id, id));
}

export async function deleteGmailAccount(id: number): Promise<void> {
  await db.delete(gmailAccounts).where(eq(gmailAccounts.id, id));
}
