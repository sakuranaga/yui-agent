/**
 * POST /api/mail/empty-trash
 *   ゴミ箱 (trashed_at IS NOT NULL) の全 row を物理削除。
 *   ON CONFLICT DO NOTHING (mail-poll) で永続的に「再同期されない」保証は
 *   なくなる (= 再度 Gmail に同じメッセージがあれば再 fetch される)。
 *   ただし通常運用ではゴミ箱を空にするのは「もう要らない」明示なので問題なし。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
import { isNotNull } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const res = await db
      .delete(mailMessages)
      .where(isNotNull(mailMessages.trashedAt));
    const count =
      (res as unknown as { rowCount?: number }).rowCount ?? 0;
    return NextResponse.json({ ok: true, deleted: count });
  } catch (e) {
    return clientError(req, e, { context: "mail/empty-trash", message: "ゴミ箱の空化に失敗しました" });
  }
}
