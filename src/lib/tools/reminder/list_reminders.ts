import { listReminders } from "@/lib/reminders";
import type { ToolDef } from "../types";

export const listRemindersTool: ToolDef = {
  name: "list_reminders",
  description: "現在有効なリマインダー全件を返す (新しい順)。",
  input_schema: {
    type: "object",
    properties: {
      include_disabled: {
        type: "boolean",
        description: "true なら無効化済みのものも含む (既定 false)",
      },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "reminder",
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { include_disabled?: unknown };
    const list = await listReminders({
      sessionId: ctx.sessionId,
      enabled: i.include_disabled ? undefined : true,
    });
    return {
      count: list.length,
      reminders: list.map((r) => ({
        id: r.id,
        kind: r.kind,
        title: r.title,
        schedule: r.schedule,
        enabled: r.enabled,
        next_due_at: r.nextDueAt?.toISOString() ?? null,
        last_fired_at: r.lastFiredAt?.toISOString() ?? null,
        ref_table: r.refTable,
        ref_id: r.refId,
      })),
    };
  },
};
