import { archiveProject } from "@/lib/todos";
import type { ToolDef } from "../types";

export const archiveProjectTool: ToolDef = {
  name: "archive_project",
  description: "project を archive (隠す)。完了したプロジェクト整理用。",
  input_schema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "project",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { id?: unknown };
    if (typeof i.id !== "number" || !i.id) throw new Error("id required");
    const p = await archiveProject(i.id);
    return p ? `P-${p.id}|archived` : "not found";
  },
};
