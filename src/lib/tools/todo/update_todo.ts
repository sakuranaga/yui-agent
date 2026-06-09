import { updateTodo, formatTodoCompact } from "@/lib/todos";
import type { ToolDef } from "../types";

export const updateTodoTool: ToolDef = {
  name: "update_todo",
  description:
    "TODO を更新。identifier (例: 'T-42') 必須。指定したフィールドだけ更新。" +
    "state を 'done' にすると completed_at 自動セット。",
  input_schema: {
    type: "object",
    properties: {
      identifier: { type: "string" },
      title: { type: "string" },
      project: { type: "string", description: "project 名 (空文字で project 解除)" },
      tags: { type: "array", items: { type: "string" } },
      note: { type: "string" },
      url: { type: "string" },
      state: { type: "string", enum: ["backlog", "in_progress", "blocked", "done"] },
      priority: { type: "integer", enum: [1, 2, 3] },
      start_at: { type: "string" },
      due_at: { type: "string" },
    },
    required: ["identifier"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "todo",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as {
      identifier?: unknown;
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
    if (typeof i.identifier !== "string" || !i.identifier) throw new Error("identifier required");
    const projectName = typeof i.project === "string" ? i.project : undefined;
    const updated = await updateTodo({
      identifier: i.identifier,
      title: typeof i.title === "string" ? i.title : undefined,
      projectName,
      tags: Array.isArray(i.tags) ? (i.tags as string[]) : undefined,
      note: typeof i.note === "string" ? i.note : undefined,
      url: typeof i.url === "string" ? i.url : undefined,
      state: i.state as "backlog" | "in_progress" | "blocked" | "done" | undefined,
      priority: i.priority as 1 | 2 | 3 | undefined,
      startAt: typeof i.start_at === "string" ? new Date(i.start_at) : undefined,
      dueAt: typeof i.due_at === "string" ? new Date(i.due_at) : undefined,
    });
    return updated ? formatTodoCompact(updated, projectName ?? null) : "not found";
  },
};
