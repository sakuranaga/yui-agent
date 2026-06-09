import { deleteTodo } from "@/lib/todos";
import type { ToolDef } from "../types";

export const deleteTodoTool: ToolDef = {
  name: "delete_todo",
  description: "TODO を完全削除 (完了マークではなく行ごと削除)。identifier 必須。",
  input_schema: {
    type: "object",
    properties: { identifier: { type: "string" } },
    required: ["identifier"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "todo",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "confirm_destructive",
  handler: async (input) => {
    const i = (input ?? {}) as { identifier?: unknown };
    if (typeof i.identifier !== "string" || !i.identifier) throw new Error("identifier required");
    const t = await deleteTodo(i.identifier);
    return t ? `${t.identifier}|deleted` : "not found";
  },
};
