import { cancelTimer, cancelTimerByMatch } from "@/lib/timers";
import type { ToolDef } from "../types";

export const cancelTimerTool: ToolDef = {
  name: "cancel_timer",
  description:
    "タイマー / アラームを取り消す。id 指定が一番確実。" +
    "id を知らないなら match (ラベルや 'タイマー'/'アラーム' のキーワード) で fuzzy 検索。" +
    "match だけで複数候補ある場合は最も新しいものを取り消す。",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "integer" },
      match: { type: "string", description: "label 部分一致 or 'timer'/'alarm'" },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "timer",
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { id?: unknown; match?: unknown };
    if (typeof i.id === "number") {
      const ok = await cancelTimer(i.id);
      return { cancelled: ok, id: i.id };
    }
    const cancelled = await cancelTimerByMatch({
      sessionId: ctx.sessionId,
      match: typeof i.match === "string" ? i.match : undefined,
    });
    return {
      cancelled: !!cancelled,
      ...(cancelled
        ? {
            id: cancelled.id,
            kind: cancelled.kind,
            label: cancelled.label,
          }
        : { note: "該当 active timer なし" }),
    };
  },
};
