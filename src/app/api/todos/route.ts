/**
 * GET /api/todos?project=&tag=&states=backlog,in_progress&q=&before=<id>&limit=50&include_completed=
 *   TODO 一覧 (UI 用)。Yui の list_todos と別経路で、フロント TodoModal から直接叩く。
 *   - project / tag / states / q (検索) / due_before / include_completed を組み合わせ可
 *   - before = 前ページ最後の todo.id (ID 降順カーソル)
 *   - 結果は降順 (最近作成順) で limit 件
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { projects, projectLinks, todos } from "@/db/schema";
import { and, asc, desc, eq, inArray, lt, sql, type SQL } from "drizzle-orm";
import { addTodo } from "@/lib/todos";
import { clientError } from "@/lib/api-error";

function parseTs(s: string | null): Date | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? new Date(n) : undefined;
}

export async function GET(req: NextRequest) {
  const project = req.nextUrl.searchParams.get("project");
  const tag = req.nextUrl.searchParams.get("tag");
  const statesRaw = req.nextUrl.searchParams.get("states");
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const dueBefore = parseTs(req.nextUrl.searchParams.get("due_before"));
  const includeCompleted = req.nextUrl.searchParams.get("include_completed") === "1";
  const beforeId = parseInt(req.nextUrl.searchParams.get("before") ?? "", 10);
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 1000) : 50;

  const states = statesRaw
    ? statesRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : null;

  const conds: SQL[] = [];

  if (project === "__no_project__") {
    // 「プロジェクトなし」(Inbox) を明示的に絞り込む sentinel
    conds.push(sql`${todos.projectId} IS NULL`);
  } else if (project) {
    const [p] = await db.select().from(projects).where(eq(projects.name, project)).limit(1);
    if (!p) return NextResponse.json({ count: 0, todos: [] });
    conds.push(eq(todos.projectId, p.id));
  }
  if (tag) conds.push(sql`${todos.tags} @> ARRAY[${tag}]::text[]`);
  if (states && states.length > 0) {
    conds.push(inArray(todos.state, states));
  } else if (!includeCompleted) {
    conds.push(sql`${todos.state} != 'done'`);
  }
  if (q) {
    conds.push(
      sql`(${todos.title} ILIKE ${`%${q}%`} OR ${todos.note} ILIKE ${`%${q}%`} OR ${todos.identifier} = ${q} OR ${todos.externalRef} = ${q})`
    );
  }
  if (dueBefore) {
    conds.push(
      sql`(${todos.dueAt} IS NOT NULL AND ${todos.dueAt} <= ${dueBefore})`
    );
  }
  if (Number.isFinite(beforeId) && beforeId > 0) {
    conds.push(lt(todos.id, beforeId));
  }

  try {
    const rows = await db
      .select({
        id: todos.id,
        identifier: todos.identifier,
        title: todos.title,
        note: todos.note,
        url: todos.url,
        state: todos.state,
        priority: todos.priority,
        tags: todos.tags,
        startAt: todos.startAt,
        dueAt: todos.dueAt,
        completedAt: todos.completedAt,
        createdAt: todos.createdAt,
        externalRef: todos.externalRef,
        projectId: todos.projectId,
        projectName: projects.name,
        projectColor: projects.color,
      })
      .from(todos)
      .leftJoin(projects, eq(todos.projectId, projects.id))
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(todos.id))
      .limit(limit);

    // 全 todo の project_links を 1 クエリで bulk fetch して client 側で集約。
    // M:N 化により list card でも複数 chip 表示するため。
    const todoIds = rows.map((r) => String(r.id));
    type LinkRow = {
      artifactId: string;
      projectId: number;
      name: string;
      color: string | null;
      linkedBy: string;
    };
    const linkRows: LinkRow[] =
      todoIds.length > 0
        ? await db
            .select({
              artifactId: projectLinks.artifactId,
              projectId: projects.id,
              name: projects.name,
              color: projects.color,
              linkedBy: projectLinks.linkedBy,
            })
            .from(projectLinks)
            .innerJoin(projects, eq(projects.id, projectLinks.projectId))
            .where(
              and(
                eq(projectLinks.artifactType, "todo"),
                inArray(projectLinks.artifactId, todoIds)
              )
            )
            .orderBy(asc(projects.sortOrder), asc(projects.name))
        : [];
    const linksByTodo = new Map<string, Array<{ id: number; name: string; color: string | null; linked_by: string }>>();
    for (const lr of linkRows) {
      const arr = linksByTodo.get(lr.artifactId) ?? [];
      arr.push({
        id: Number(lr.projectId),
        name: lr.name,
        color: lr.color,
        linked_by: lr.linkedBy,
      });
      linksByTodo.set(lr.artifactId, arr);
    }

    return NextResponse.json({
      count: rows.length,
      todos: rows.map((r) => ({
        id: Number(r.id),
        identifier: r.identifier,
        title: r.title,
        note: r.note,
        url: r.url,
        state: r.state,
        priority: r.priority,
        tags: r.tags,
        start_at: r.startAt?.toISOString() ?? null,
        due_at: r.dueAt?.toISOString() ?? null,
        completed_at: r.completedAt?.toISOString() ?? null,
        created_at: r.createdAt.toISOString(),
        external_ref: r.externalRef,
        project_id: r.projectId !== null ? Number(r.projectId) : null,
        project_name: r.projectName,
        project_color: r.projectColor,
        // M:N: list card で複数 chip 表示するため、紐付いてる全 project を返す
        // (primary も含む)
        linked_projects: linksByTodo.get(String(r.id)) ?? [],
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "todos", message: "TODO 一覧の取得に失敗しました" });
  }
}

/**
 * POST /api/todos — 新規 TODO 作成 (UI から)。Yui ターン経由しないで直接。
 * Body: { title, project?, tags?, note?, url?, state?, priority?, start_at?, due_at?, session_id? }
 */
export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      title?: string;
      project?: string;
      tags?: string[];
      note?: string;
      url?: string;
      state?: "backlog" | "in_progress" | "blocked" | "done";
      priority?: 1 | 2 | 3;
      start_at?: string;
      due_at?: string;
      session_id?: string;
      bypass_dedup?: boolean;
      // intent dispatch から呼ばれた時の出典 source。設定があれば artifact_links に
      // back-link 行を書く。
      source?: { type?: string; id?: string };
    };
    if (!body.title) {
      return NextResponse.json({ error: "title required" }, { status: 400 });
    }
    const result = await addTodo({
      sessionId: body.session_id ?? "ui",
      title: body.title,
      projectName: body.project,
      tags: body.tags,
      note: body.note,
      url: body.url,
      state: body.state,
      priority: body.priority,
      startAt: body.start_at ? new Date(body.start_at) : undefined,
      dueAt: body.due_at ? new Date(body.due_at) : undefined,
      bypassDedup: body.bypass_dedup === true,
    });

    // 出典 source があれば artifact_links に back-link を書く
    if (
      body.source &&
      typeof body.source.type === "string" &&
      typeof body.source.id === "string" &&
      ["mail", "event", "todo", "contact", "diary"].includes(body.source.type)
    ) {
      try {
        const { attachArtifactLink } = await import("@/lib/artifact-links");
        await attachArtifactLink({
          sourceType: body.source.type as
            | "mail" | "event" | "todo" | "contact" | "diary",
          sourceId: body.source.id,
          targetType: "todo",
          targetId: String(result.todo.id),
          createdBy: "intent",
        });
      } catch (e) {
        console.warn("[api/todos] artifact_link attach failed:", e);
      }
    }

    return NextResponse.json({
      ok: true,
      todo: result.todo,
      duplicated_existing: result.duplicatedExisting ?? null,
    });
  } catch (e) {
    return clientError(req, e, { context: "todos", message: "TODO の作成に失敗しました" });
  }
}
