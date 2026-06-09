import { listActiveTimers } from "@/lib/timers";
import type { ToolDef } from "../types";

export const listTimersTool: ToolDef = {
  name: "list_timers",
  description: "現在 active な (pending の) タイマー/アラームを全件返す。",
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "timer",
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (_input, ctx) => {
    const list = await listActiveTimers(ctx.sessionId);
    return {
      count: list.length,
      timers: list.map((t) => ({
        id: t.id,
        kind: t.kind,
        label: t.label,
        target_at: t.targetAt.toISOString(),
      })),
    };
  },
};
