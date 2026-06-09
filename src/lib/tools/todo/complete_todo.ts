import { completeTodo } from "@/lib/todos";
import type { ToolDef } from "../types";

export const completeTodoTool: ToolDef = {
  name: "complete_todo",
  description: "TODO を完了マーク (state='done' + completed_at セット)。identifier 必須。",
  input_schema: {
    type: "object",
    properties: {
      identifier: { type: "string", description: "T-42 等" },
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
    const i = (input ?? {}) as { identifier?: unknown };
    if (typeof i.identifier !== "string" || !i.identifier) throw new Error("identifier required");
    const t = await completeTodo(i.identifier);
    return t ? `${t.identifier}|done` : "not found";
  },
};
