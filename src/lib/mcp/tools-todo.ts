/**
 * ゆい MCP サーバ: TODO tool (docs/yui-mcp-server.md §5.2)。
 * flat な MCP schema を既存 lib (todos.ts) の入力型へ変換して呼ぶ。
 * 物理削除 (deleteTodo) は公開せず、完了 (completeTodo) をソフト削除相当とする。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { addTodo, listTodos, searchTodos, updateTodo, completeTodo } from "@/lib/todos";
import type { Todo } from "@/db/schema";
import { MCP_OWNER_SESSION_ID } from "./const";

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}
function fail(context: string, e: unknown, message: string) {
  console.error(`[mcp:${context}]`, e instanceof Error ? e.message : e);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

/** ISO 文字列を Date に。空/未指定は undefined、不正は throw (= 黙って無視しない)。 */
function parseDate(s: string | undefined, label: string): Date | undefined {
  if (s === undefined || s.trim() === "") return undefined;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date for ${label}: ${s}`);
  return d;
}

function todoView(t: Todo, projectName: string | null) {
  return {
    id: t.id,
    identifier: t.identifier,
    title: t.title,
    state: t.state,
    priority: t.priority,
    project: projectName,
    due_at: t.dueAt ? t.dueAt.toISOString() : null,
    start_at: t.startAt ? t.startAt.toISOString() : null,
  };
}

const STATE = z.enum(["backlog", "in_progress", "blocked", "done", "cancelled"]);

export function registerTodoTools(server: McpServer): void {
  server.registerTool(
    "todo_add",
    {
      title: "TODO 追加",
      description: "TODO を作成する。project / due (ISO8601) / priority(1-3) は任意。",
      inputSchema: {
        title: z.string().trim().min(1).describe("TODO のタイトル"),
        project: z.string().optional().describe("プロジェクト名 (無ければ未分類)"),
        due: z.string().optional().describe("期限 ISO8601 (例 2026-06-20T18:00:00+09:00)"),
        priority: z.number().int().min(1).max(3).optional().describe("1=高 2=中 3=低"),
        state: STATE.optional().describe("初期状態 (既定 backlog)"),
        note: z.string().optional(),
        tags: z.array(z.string()).optional(),
      },
    },
    async ({ title, project, due, priority, state, note, tags }) => {
      try {
        const res = await addTodo({
          sessionId: MCP_OWNER_SESSION_ID,
          title,
          projectName: project,
          dueAt: parseDate(due, "due"),
          priority: priority as 1 | 2 | 3 | undefined,
          state,
          note,
          tags,
        });
        return ok({ id: res.todo.id, identifier: res.todo.identifier, title: res.todo.title });
      } catch (e) {
        return fail("todo_add", e, "TODO の作成に失敗しました");
      }
    }
  );

  server.registerTool(
    "todo_list",
    {
      title: "TODO 一覧",
      description: "TODO を一覧する。project 絞り込み・完了含む・件数制限は任意。",
      inputSchema: {
        project: z.string().optional(),
        include_done: z.boolean().optional().describe("完了・中止 (inactive) も含めるか (既定 false)"),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ project, include_done, limit }) => {
      try {
        const rows = await listTodos({
          projectName: project,
          includeCompleted: include_done,
          limit,
        });
        return ok({ todos: rows.map((r) => todoView(r.todo, r.projectName)) });
      } catch (e) {
        return fail("todo_list", e, "TODO の一覧取得に失敗しました");
      }
    }
  );

  server.registerTool(
    "todo_search",
    {
      title: "TODO 検索",
      description: "タイトル/本文で TODO を検索する。",
      inputSchema: {
        query: z.string().trim().min(1),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async ({ query, limit }) => {
      try {
        const rows = await searchTodos(query, limit ?? 10);
        return ok({ todos: rows.map((r) => todoView(r.todo, r.projectName)) });
      } catch (e) {
        return fail("todo_search", e, "TODO の検索に失敗しました");
      }
    }
  );

  server.registerTool(
    "todo_update",
    {
      title: "TODO 更新",
      description: "identifier を指定して TODO を更新する (title/project/due/priority/state/note)。",
      inputSchema: {
        identifier: z.string().trim().min(1).describe("TODO の identifier"),
        title: z.string().optional(),
        project: z.string().nullable().optional().describe("null でプロジェクト解除"),
        due: z.string().nullable().optional().describe("ISO8601 / null で期限解除"),
        priority: z.number().int().min(1).max(3).optional(),
        state: STATE.optional(),
        note: z.string().optional(),
      },
    },
    async ({ identifier, title, project, due, priority, state, note }) => {
      try {
        const dueAt =
          due === null ? null : due === undefined ? undefined : parseDate(due, "due");
        const updated = await updateTodo({
          identifier,
          title,
          projectName: project,
          dueAt,
          priority: priority as 1 | 2 | 3 | undefined,
          state,
          note,
        });
        if (!updated) return ok({ updated: false, identifier });
        return ok({ updated: true, id: updated.id, identifier: updated.identifier });
      } catch (e) {
        return fail("todo_update", e, "TODO の更新に失敗しました");
      }
    }
  );

  server.registerTool(
    "todo_complete",
    {
      title: "TODO 完了",
      description:
        "TODO を完了にする (= ソフト削除相当)。物理削除は MCP からはできない。",
      inputSchema: { identifier: z.string().trim().min(1).describe("TODO の identifier") },
    },
    async ({ identifier }) => {
      try {
        const done = await completeTodo(identifier);
        if (!done) return ok({ completed: false, identifier });
        return ok({ completed: true, id: done.id, identifier: done.identifier });
      } catch (e) {
        return fail("todo_complete", e, "TODO の完了処理に失敗しました");
      }
    }
  );
}
