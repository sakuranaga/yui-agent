/**
 * POST /api/mail/batch
 *   複数 ID への一括 state 変更。
 *   body: { ids: number[], patch: { read?, starred?, archived?, trashed? } }
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
import { inArray } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      ids?: number[];
      patch?: { read?: boolean; starred?: boolean; archived?: boolean; trashed?: boolean };
    };
    const ids = (body.ids ?? []).filter((n) => Number.isFinite(n));
    if (ids.length === 0) {
      return NextResponse.json({ ok: true, count: 0 });
    }
    const p = body.patch ?? {};
    const now = new Date();
    const set: Record<string, Date | null> = {};
    if (p.read !== undefined) set.readAt = p.read ? now : null;
    if (p.starred !== undefined) set.starredAt = p.starred ? now : null;
    if (p.archived !== undefined) set.archivedAt = p.archived ? now : null;
    if (p.trashed !== undefined) set.trashedAt = p.trashed ? now : null;
    if (Object.keys(set).length === 0) {
      return NextResponse.json({ ok: true, noop: true });
    }
    await db.update(mailMessages).set(set).where(inArray(mailMessages.id, ids));
    return NextResponse.json({ ok: true, count: ids.length });
  } catch (e) {
    return clientError(req, e, { status: 400, context: "mail/batch", message: "メール一括操作に失敗しました" });
  }
}
