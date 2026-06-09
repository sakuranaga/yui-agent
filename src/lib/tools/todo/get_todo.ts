import { getTodoByIdentifier } from "@/lib/todos";
import type { ToolDef } from "../types";

export const getTodoTool: ToolDef = {
  name: "get_todo",
  description: "TODO 1 件の詳細 (note 含む) を取得。identifier 必須。",
  input_schema: {
    type: "object",
    properties: { identifier: { type: "string" } },
    required: ["identifier"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "todo",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { identifier?: unknown };
    if (typeof i.identifier !== "string" || !i.identifier) throw new Error("identifier required");
    const t = await getTodoByIdentifier(i.identifier);
    if (!t) return "not found";
    // 詳細は note 含むので JSON object で返す (runtime が JSON.stringify する)
    return {
      identifier: t.identifier,
      title: t.title,
      state: t.state,
      priority: t.priority,
      project_id: t.projectId,
      tags: t.tags,
      note: t.note,
      url: t.url,
      start_at: t.startAt?.toISOString() ?? null,
      due_at: t.dueAt?.toISOString() ?? null,
      completed_at: t.completedAt?.toISOString() ?? null,
      created_at: t.createdAt.toISOString(),
      external_ref: t.externalRef,
    };
  },
};
