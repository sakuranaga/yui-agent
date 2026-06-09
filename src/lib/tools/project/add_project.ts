import { getOrCreateProject, updateProject } from "@/lib/todos";
import type { ToolDef } from "../types";

export const addProjectTool: ToolDef = {
  name: "add_project",
  description: "project を明示作成 (todo 追加時の自動作成と別に、属性付き作成したい時)。",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string" },
      color: { type: "string", description: "#hex" },
      description: { type: "string" },
      start_at: { type: "string" },
      due_at: { type: "string" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "project",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as {
      name?: unknown;
      color?: unknown;
      description?: unknown;
      start_at?: unknown;
      due_at?: unknown;
    };
    if (typeof i.name !== "string" || !i.name) throw new Error("name required");
    const p = await getOrCreateProject(i.name);
    // optional 属性を埋める
    const patched = await updateProject(p.id, {
      color: typeof i.color === "string" ? i.color : undefined,
      description: typeof i.description === "string" ? i.description : undefined,
      startAt: typeof i.start_at === "string" ? new Date(i.start_at) : undefined,
      dueAt: typeof i.due_at === "string" ? new Date(i.due_at) : undefined,
    });
    const proj = patched ?? p;
    return `P-${proj.id}|${proj.name}|${proj.color ?? "-"}`;
  },
};
