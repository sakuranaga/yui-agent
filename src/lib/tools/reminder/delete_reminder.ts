import { deleteReminder } from "@/lib/reminders";
import type { ToolDef } from "../types";

export const deleteReminderTool: ToolDef = {
  name: "delete_reminder",
  description: "リマインダーを完全削除する。disable で十分なら disable_reminder を優先。",
  input_schema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "reminder",
  allowedModes: ["normal"],
  confirmationPolicy: "confirm_destructive",
  handler: async (input) => {
    const i = (input ?? {}) as { id?: unknown };
    if (typeof i.id !== "number") throw new Error("id is required");
    const ok = await deleteReminder(i.id);
    return { deleted: ok, id: i.id };
  },
};
