/**
 * PATCH /api/projects/[id] — フィールド部分更新 (name / color / description / start_at / due_at / archived)
 * DELETE /api/projects/[id] — 完全削除。関連 todo の project_id は NULL に流して Inbox 行きに。
 */
import { NextResponse, type NextRequest } from "next/server";
import { updateProject, deleteProject } from "@/lib/todos";
import { clientError } from "@/lib/api-error";

type Patch = {
  name?: string;
  color?: string | null;
  description?: string | null;
  start_at?: string | null;
  due_at?: string | null;
  archived?: boolean;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as Patch;
    const patch: Parameters<typeof updateProject>[1] = {};
    if (body.name !== undefined) patch.name = body.name;
    if (body.color !== undefined) patch.color = body.color;
    if (body.description !== undefined) patch.description = body.description;
    if (body.archived !== undefined) patch.archived = body.archived;
    if (body.start_at !== undefined) {
      patch.startAt = body.start_at ? new Date(body.start_at) : null;
    }
    if (body.due_at !== undefined) {
      patch.dueAt = body.due_at ? new Date(body.due_at) : null;
    }
    const updated = await updateProject(projectId, patch);
    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true, project: updated });
  } catch (e) {
    return clientError(req, e, { context: "projects/[id]", message: "プロジェクトの更新に失敗しました" });
  }
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const projectId = parseInt(id, 10);
  if (!Number.isFinite(projectId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const ok = await deleteProject(projectId);
    if (!ok) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "projects/[id]", message: "プロジェクトの削除に失敗しました" });
  }
}
