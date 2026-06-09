/**
 * PATCH  /api/reminders/<id>   → 編集 (title / extra_prompt / schedule / enabled)
 * DELETE /api/reminders/<id>   → 削除
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  updateReminder,
  deleteReminder,
  type UpdateReminderInput,
} from "@/lib/reminders";
import { clientError } from "@/lib/api-error";

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
    const body = (await req.json()) as Partial<UpdateReminderInput>;
    const row = await updateReminder({
      id: numId,
      title: body.title,
      extraPrompt: body.extraPrompt,
      schedule: body.schedule,
      enabled: body.enabled,
    });
    if (!row) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({
      id: row.id,
      enabled: row.enabled,
      title: row.title,
      next_due_at: row.nextDueAt?.toISOString() ?? null,
    });
  } catch (e) {
    return clientError(req, e, { context: "reminders/[id]", message: "リマインダーの更新に失敗しました" });
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
    const ok = await deleteReminder(numId);
    return NextResponse.json({ deleted: ok, id: numId });
  } catch (e) {
    return clientError(req, e, { context: "reminders/[id]", message: "リマインダーの削除に失敗しました" });
  }
}
