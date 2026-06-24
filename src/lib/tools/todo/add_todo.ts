import { addTodo, formatTodoCompact } from "@/lib/todos";
import type { ToolDef } from "../types";

export const addTodoTool: ToolDef = {
  name: "add_todo",
  description:
    "TODO / タスク / 欲しい物 / 行きたい所 / プロジェクト work item を 1 件追加。" +
    "identifier (例: 'T-42') が自動採番されて返る。" +
    "project は自由文字列 (例: 'Yui アプリ', '本', '個人TODO')、未存在なら自動作成。" +
    "tags は複数可 (例: ['本','緊急'])。" +
    "state は 'backlog'(既定)/'in_progress'/'blocked'/'done'。" +
    "priority 1=低, 2=中(既定), 3=高。due_at/start_at は ISO8601。",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "短いタイトル" },
      project: { type: "string", description: "(任意) project 名。未存在なら自動作成" },
      tags: { type: "array", items: { type: "string" }, description: "(任意) 自由テキストタグ複数" },
      note: { type: "string" },
      url: { type: "string" },
      state: { type: "string", enum: ["backlog", "in_progress", "blocked", "done", "cancelled"] },
      priority: { type: "integer", enum: [1, 2, 3] },
      start_at: { type: "string", description: "ISO8601 開始日" },
      due_at: { type: "string", description: "ISO8601 期限" },
    },
    required: ["title"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "todo",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
      title?: unknown;
      project?: unknown;
      tags?: unknown;
      note?: unknown;
      url?: unknown;
      state?: unknown;
      priority?: unknown;
      start_at?: unknown;
      due_at?: unknown;
    };
    if (typeof i.title !== "string" || !i.title) throw new Error("title required");
    const projectName = typeof i.project === "string" ? i.project : undefined;
    const result = await addTodo({
      sessionId: ctx.sessionId,
      title: i.title,
      projectName,
      tags: Array.isArray(i.tags) ? (i.tags as string[]) : undefined,
      note: typeof i.note === "string" ? i.note : undefined,
      url: typeof i.url === "string" ? i.url : undefined,
      state: i.state as "backlog" | "in_progress" | "blocked" | "done" | undefined,
      priority: i.priority as 1 | 2 | 3 | undefined,
      startAt: typeof i.start_at === "string" ? new Date(i.start_at) : undefined,
      dueAt: typeof i.due_at === "string" ? new Date(i.due_at) : undefined,
      // Yui ターン経由は default の dedup ON (前ターン依頼の再 dispatch ガード)
    });
    return formatTodoCompact(result.todo, projectName ?? null);
  },
};
