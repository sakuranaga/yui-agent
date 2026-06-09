import { listProjects, formatProjectListMarkdown } from "@/lib/todos";
import { pushToSession } from "@/lib/jobs/events";
import type { ToolDef } from "../types";

export const listProjectsTool: ToolDef = {
  name: "list_projects",
  description: "全 project の一覧 (archived 除外)。出力: 'P-1|name|color' 形式。",
  input_schema: {
    type: "object",
    properties: {
      include_archived: { type: "boolean" },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "project",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { include_archived?: unknown };
    const list = await listProjects({ includeArchived: i.include_archived === true });
    const lines = list.map(
      (p) => `P-${p.id}|${p.name}|${p.color ?? "-"}|${p.archived ? "archived" : "active"}`
    );
    if (list.length > 0) {
      const report = formatProjectListMarkdown(list);
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
