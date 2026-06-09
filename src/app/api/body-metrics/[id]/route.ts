/**
 * DELETE /api/body-metrics/<id>   個別 metric 削除 (修正は POST 再投入で代替)
 */
import { NextResponse } from "next/server";
import { db } from "@/db/client";
import { bodyMetrics } from "@/db/schema";
import { eq } from "drizzle-orm";

export const dynamic = "force-dynamic";

export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = parseInt(id, 10);
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  await db.delete(bodyMetrics).where(eq(bodyMetrics.id, idNum));
  return NextResponse.json({ ok: true });
}
