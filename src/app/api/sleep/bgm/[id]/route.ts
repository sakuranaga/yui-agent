/**
 * DELETE /api/sleep/bgm/[id]
 *   upload された BGM の row + ファイル本体を削除。
 *
 * legacy preset (= is_uploaded=false) は配布物に同梱されているので削除不可
 *   (= 削除しても public/sleep-bgm/ のファイル本体は残る、混乱を避けるため 403)。
 *   無効化したい時は enabled を false にする別 endpoint で対応。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { sleepBgm } from "@/db/schema";
import { eq } from "drizzle-orm";
import { deleteUploadedBgmFile } from "@/lib/sleep-bgm-storage";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const num = parseInt(id, 10);
  if (!Number.isFinite(num) || num <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const [row] = await db.select().from(sleepBgm).where(eq(sleepBgm.id, num));
    if (!row) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    if (!row.isUploaded) {
      return NextResponse.json(
        {
          error:
            "legacy preset (= 配布物に同梱) は削除できません。無効化する場合は enabled を切り替えてください。",
        },
        { status: 403 }
      );
    }

    await deleteUploadedBgmFile(num);
    await db.delete(sleepBgm).where(eq(sleepBgm.id, num));
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, {
      status: 500,
      message: "BGM の削除に失敗しました",
      context: "sleep/bgm DELETE",
    });
  }
}
