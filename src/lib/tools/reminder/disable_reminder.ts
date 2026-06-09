import { updateReminder } from "@/lib/reminders";
import type { ToolDef } from "../types";

export const disableReminderTool: ToolDef = {
  name: "disable_reminder",
  description: "リマインダーを一時停止 (= 削除はせず、enabled=false にする)。",
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
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { id?: unknown };
    if (typeof i.id !== "number") throw new Error("id is required");
    const row = await updateReminder({ id: i.id, enabled: false });
    return {
      ok: !!row,
      id: i.id,
      enabled: row?.enabled,
    };
  },
};
