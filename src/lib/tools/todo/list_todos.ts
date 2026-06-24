import { listTodos, formatTodoCompact, formatTodoListMarkdown } from "@/lib/todos";
import { pushToSession } from "@/lib/jobs/events";
import type { ToolDef } from "../types";

export const listTodosTool: ToolDef = {
  name: "list_todos",
  description:
    "TODO 一覧。project/tag/state でフィルタ可。デフォルトは未完了 (done/cancelled 除外)。" +
    "出力は compact 1 行 'T-42|state|due|p2|project|tags|title' 形式 (token 節約)。",
  input_schema: {
    type: "object",
    properties: {
      project: { type: "string" },
      tag: { type: "string" },
      states: {
        type: "array",
        items: { type: "string", enum: ["backlog", "in_progress", "blocked", "done", "cancelled"] },
      },
      due_before: { type: "string", description: "ISO8601 (これより前期限のみ)" },
      include_completed: { type: "boolean", description: "完了・中止 (inactive) も含める" },
      limit: { type: "integer", description: "(任意) デフォルト 50" },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "todo",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
      project?: unknown;
      tag?: unknown;
      states?: unknown;
      due_before?: unknown;
      include_completed?: unknown;
      limit?: unknown;
    };
    const projectName = typeof i.project === "string" ? i.project : undefined;
    const tag = typeof i.tag === "string" ? i.tag : undefined;
    const list = await listTodos({
      projectName,
      tag,
      states: Array.isArray(i.states)
        ? (i.states as Array<"backlog" | "in_progress" | "blocked" | "done">)
        : undefined,
      dueBefore: typeof i.due_before === "string" ? new Date(i.due_before) : undefined,
      includeCompleted: i.include_completed === true,
      limit: typeof i.limit === "number" ? i.limit : undefined,
    });
    const lines = list.map((r) => formatTodoCompact(r.todo, r.projectName));
    // ノートパネルにも markdown 一覧を流す (UI 視覚的に確認しやすく)
    if (list.length > 0) {
      const titleHint = projectName
        ? `${projectName} の TODO`
        : tag
          ? `タグ "${tag}" の TODO`
          : "TODO 一覧";
      const report = formatTodoListMarkdown(list, { titleHint });
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
