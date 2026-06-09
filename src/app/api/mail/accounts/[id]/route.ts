/**
 * PATCH  /api/mail/accounts/<id>   { enabled?, isPrimary?, displayName?, initialSyncDays? }
 * DELETE /api/mail/accounts/<id>   登録解除 (mail_messages も CASCADE で削除)
 */
import { NextResponse, type NextRequest } from "next/server";
import { setEnabled, setPrimary, deleteGmailAccount } from "@/lib/mail-accounts";
import { db } from "@/db/client";
import { gmailAccounts } from "@/db/schema";
import { eq } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as {
      enabled?: boolean;
      isPrimary?: boolean;
      displayName?: string | null;
      initialSyncDays?: number;
    };
    if (body.isPrimary === true) {
      await setPrimary(numId);
    }
    if (typeof body.enabled === "boolean") {
      await setEnabled(numId, body.enabled);
    }
    const setOther: { displayName?: string | null; initialSyncDays?: number } = {};
    if (body.displayName !== undefined) setOther.displayName = body.displayName;
    if (typeof body.initialSyncDays === "number") {
      setOther.initialSyncDays = Math.max(1, Math.min(30, Math.floor(body.initialSyncDays)));
    }
    if (Object.keys(setOther).length > 0) {
      await db.update(gmailAccounts).set(setOther).where(eq(gmailAccounts.id, numId));
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { status: 400, context: "mail/accounts/[id]", message: "アカウント設定の更新に失敗しました" });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    await deleteGmailAccount(numId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { status: 400, context: "mail/accounts/[id]", message: "アカウントの削除に失敗しました" });
  }
}
