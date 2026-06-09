import { searchTodos, formatTodoCompact, formatTodoListMarkdown } from "@/lib/todos";
import { pushToSession } from "@/lib/jobs/events";
import type { ToolDef } from "../types";

export const searchTodosTool: ToolDef = {
  name: "search_todos",
  description: "TODO 横断キーワード検索 (title/note/identifier/external_ref 部分一致)。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "todo",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { query?: unknown; limit?: unknown };
    if (typeof i.query !== "string" || !i.query) throw new Error("query required");
    const limit = typeof i.limit === "number" ? i.limit : undefined;
    const list = await searchTodos(i.query, limit);
    const lines = list.map((r) => formatTodoCompact(r.todo, r.projectName));
    if (list.length > 0) {
      const report = formatTodoListMarkdown(list, {
        titleHint: `検索: "${i.query}"`,
      });
      pushToSession(ctx.sessionId, {
        type: "report_update",
        jobId: Date.now(),
        title: report.title,
        markdown: report.markdown,
      });
    }
    return lines.length > 0 ? `count=${lines.length}\n${lines.join("\n")}` : "count=0";
  },
};
