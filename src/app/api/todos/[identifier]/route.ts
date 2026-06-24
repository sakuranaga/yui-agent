/**
 * PATCH /api/todos/[identifier] — フィールド部分更新
 * DELETE /api/todos/[identifier] — 行削除
 *
 * identifier は "T-42" or 旧 Plane "WORK-42" (external_ref) どちらも OK。
 * Body: { title?, project?, tags?, note?, url?, state?, priority?, start_at?, due_at? }
 *   - project: 文字列名 (未存在は自動作成)。null で project 解除。
 *   - state を 'done' に変えると completed_at 自動セット。done から戻ると clear。
 */
import { NextResponse, type NextRequest } from "next/server";
import { updateTodo, deleteTodo, getTodoByIdentifier } from "@/lib/todos";
import { clientError } from "@/lib/api-error";

type Patch = {
  title?: string;
  project?: string | null;
  tags?: string[];
  note?: string;
  url?: string;
  state?: "backlog" | "in_progress" | "blocked" | "done" | "cancelled";
  priority?: 1 | 2 | 3;
  start_at?: string | null;
  due_at?: string | null;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params;
  try {
    const body = (await req.json()) as Patch;
    // identifier が external_ref の場合、実 identifier に変換
    const found = await getTodoByIdentifier(identifier);
    if (!found) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    const updated = await updateTodo({
      identifier: found.identifier,
      title: body.title,
      projectName: body.project,
      tags: body.tags,
      note: body.note,
      url: body.url,
      state: body.state,
      priority: body.priority,
      startAt: body.start_at === null ? null : body.start_at ? new Date(body.start_at) : undefined,
      dueAt: body.due_at === null ? null : body.due_at ? new Date(body.due_at) : undefined,
    });
    return NextResponse.json({ ok: true, todo: updated });
  } catch (e) {
    return clientError(req, e, { context: "todos/[identifier]", message: "TODO の更新に失敗しました" });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ identifier: string }> }
) {
  const { identifier } = await params;
  try {
    const found = await getTodoByIdentifier(identifier);
    if (!found) return NextResponse.json({ error: "not found" }, { status: 404 });
    const deleted = await deleteTodo(found.identifier);
    return NextResponse.json({ ok: true, deleted });
  } catch (e) {
    return clientError(req, e, { context: "todos/[identifier]", message: "TODO の削除に失敗しました" });
  }
}
