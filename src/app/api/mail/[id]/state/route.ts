/**
 * PATCH /api/mail/<id>/state
 *   body: { read?, starred?, archived?, trashed? }
 *   アプリローカル状態のみ更新。Gmail には書き戻さない。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
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
      read?: boolean;
      starred?: boolean;
      archived?: boolean;
      trashed?: boolean;
    };
    const now = new Date();
    const set: Record<string, Date | null> = {};
    if (body.read !== undefined) set.readAt = body.read ? now : null;
    if (body.starred !== undefined) set.starredAt = body.starred ? now : null;
    if (body.archived !== undefined) set.archivedAt = body.archived ? now : null;
    if (body.trashed !== undefined) set.trashedAt = body.trashed ? now : null;

    if (Object.keys(set).length === 0) {
      return NextResponse.json({ ok: true, noop: true });
    }
    await db.update(mailMessages).set(set).where(eq(mailMessages.id, numId));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { status: 400, context: "mail/[id]/state", message: "メール状態の更新に失敗しました" });
  }
}
