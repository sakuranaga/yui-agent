/**
 * PATCH  /api/mail-training/:id   bucket / hintText / autoTodo / autoEvent を更新
 *                                 embedding は再生成しない (embedded_text 不変)
 * DELETE /api/mail-training/:id   学習例削除
 *
 * 設計: docs/mail-classification.md §7.1, §7.2
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { mailTrainingExamples } from "@/db/schema";
import { eq } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

type PatchBody = {
  bucket?: "important" | "needed" | "unneeded";
  hintText?: string;
  autoTodo?: boolean;
  autoEvent?: boolean;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = parseInt(id, 10);
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  try {
    const body = (await req.json()) as PatchBody;

    const updates: Partial<typeof mailTrainingExamples.$inferInsert> = {};

    if (body.bucket !== undefined) {
      if (!["important", "needed", "unneeded"].includes(body.bucket)) {
        return NextResponse.json({ error: "invalid bucket" }, { status: 400 });
      }
      updates.bucket = body.bucket;
    }

    if (body.hintText !== undefined) {
      const trimmed = body.hintText.trim();
      if (trimmed.length === 0) {
        return NextResponse.json({ error: "hintText cannot be empty" }, { status: 400 });
      }
      updates.hintText = trimmed.slice(0, 1000);
    }

    // bucket が unneeded / needed のときは auto_* を必ず false に揃える (consent は重要時のみ意味あり)
    const effectiveBucket =
      body.bucket ?? (await getCurrentBucket(idNum));
    const isImportant = effectiveBucket === "important";
    if (body.autoTodo !== undefined) {
      updates.autoTodo = isImportant && body.autoTodo === true;
    }
    if (body.autoEvent !== undefined) {
      updates.autoEvent = isImportant && body.autoEvent === true;
    }
    // bucket を 重要 以外に変えるときは、既存の auto_* も false に強制
    if (body.bucket !== undefined && !isImportant) {
      updates.autoTodo = false;
      updates.autoEvent = false;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json({ error: "nothing to update" }, { status: 400 });
    }

    updates.updatedAt = new Date();

    const [row] = await db
      .update(mailTrainingExamples)
      .set(updates)
      .where(eq(mailTrainingExamples.id, idNum))
      .returning();

    if (!row) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    return NextResponse.json({ ok: true, example: row });
  } catch (e) {
    return clientError(req, e, { context: "mail-training/[id]", message: "学習例の更新に失敗しました" });
  }
}

async function getCurrentBucket(id: number): Promise<string | null> {
  const [row] = await db
    .select({ bucket: mailTrainingExamples.bucket })
    .from(mailTrainingExamples)
    .where(eq(mailTrainingExamples.id, id));
  return row?.bucket ?? null;
}

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = parseInt(id, 10);
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  await db.delete(mailTrainingExamples).where(eq(mailTrainingExamples.id, idNum));
  return NextResponse.json({ ok: true });
}
