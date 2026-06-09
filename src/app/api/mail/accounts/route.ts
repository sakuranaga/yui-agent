/**
 * GET  /api/mail/accounts       全アカウント一覧 (DB 登録済 + 未登録 OAuth)
 * POST /api/mail/accounts       { email, displayName? } を gmail_accounts に追加
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { googleOauthTokens } from "@/db/schema";
import { listGmailAccounts, ensureGmailAccount } from "@/lib/mail-accounts";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET() {
  const registered = await listGmailAccounts();
  // 既存 OAuth 接続済アカウントで mail 未登録のもの (= 追加候補)
  const tokens = await db
    .select({
      email: googleOauthTokens.accountEmail,
      scopes: googleOauthTokens.scopes,
    })
    .from(googleOauthTokens);
  const registeredEmails = new Set(registered.map((a) => a.email));
  const candidates = tokens
    .filter((t) => !registeredEmails.has(t.email))
    // gmail.readonly が含まれてないと意味がないので除外
    .filter((t) => (t.scopes ?? []).some((s) => s.includes("gmail")));

  return NextResponse.json({
    accounts: registered.map((a) => ({
      id: Number(a.id),
      email: a.email,
      displayName: a.displayName,
      enabled: a.enabled,
      isPrimary: a.isPrimary,
      initialSyncDays: a.initialSyncDays,
      lastSyncedAt: a.lastSyncedAt?.toISOString() ?? null,
    })),
    candidates: candidates.map((t) => ({ email: t.email })),
  });
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { email?: string; displayName?: string };
    if (!body.email || typeof body.email !== "string") {
      return NextResponse.json({ error: "email required" }, { status: 400 });
    }
    const acc = await ensureGmailAccount(body.email.trim().toLowerCase(), body.displayName);
    return NextResponse.json({ ok: true, id: Number(acc.id) });
  } catch (e) {
    return clientError(req, e, { status: 400, context: "mail/accounts", message: "アカウントの追加に失敗しました" });
  }
}
