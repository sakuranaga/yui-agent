/**
 * GET /api/projects?include_archived=1&with_counts=1
 *   project 一覧。with_counts=1 で todo 件数を含めて返す (SettingsModal 用)。
 * POST /api/projects
 *   新規プロジェクト作成。body: { name, color?, description?, start_at?, due_at? }
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  listProjects,
  listProjectsWithCounts,
  getOrCreateProject,
  updateProject,
} from "@/lib/todos";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  const includeArchived = req.nextUrl.searchParams.get("include_archived") === "1";
  const withCounts = req.nextUrl.searchParams.get("with_counts") === "1";
  try {
    if (withCounts) {
      const list = await listProjectsWithCounts({ includeArchived });
      return NextResponse.json({
        count: list.length,
        projects: list.map((p) => ({
          id: Number(p.id),
          name: p.name,
          color: p.color,
          description: p.description,
          start_at: p.startAt?.toISOString() ?? null,
          due_at: p.dueAt?.toISOString() ?? null,
          archived: p.archived,
          sort_order: p.sortOrder,
          todo_count: p.todoCount,
          active_count: p.activeCount,
        })),
      });
    }
    const list = await listProjects({ includeArchived });
    return NextResponse.json({
      count: list.length,
      projects: list.map((p) => ({
        id: Number(p.id),
        name: p.name,
        color: p.color,
        description: p.description,
        start_at: p.startAt?.toISOString() ?? null,
        due_at: p.dueAt?.toISOString() ?? null,
        archived: p.archived,
        sort_order: p.sortOrder,
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "projects", message: "プロジェクト一覧の取得に失敗しました" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      name?: string;
      color?: string | null;
      description?: string | null;
      start_at?: string | null;
      due_at?: string | null;
    };
    if (!body.name || !body.name.trim()) {
      return NextResponse.json({ error: "name required" }, { status: 400 });
    }
    const project = await getOrCreateProject(body.name);
    if (
      body.color !== undefined ||
      body.description !== undefined ||
      body.start_at !== undefined ||
      body.due_at !== undefined
    ) {
      const updated = await updateProject(project.id, {
        color: body.color ?? null,
        description: body.description ?? null,
        startAt: body.start_at ? new Date(body.start_at) : null,
        dueAt: body.due_at ? new Date(body.due_at) : null,
      });
      return NextResponse.json({ ok: true, project: updated });
    }
    return NextResponse.json({ ok: true, project });
  } catch (e) {
    return clientError(req, e, { context: "projects", message: "プロジェクトの作成に失敗しました" });
  }
}
