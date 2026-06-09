import type { ToolDef } from "../types";

export const getWorkoutHistory: ToolDef = {
  name: "get_workout_history",
  description:
    "ご主人様の筋トレ / 運動の履歴を参照する。" +
    "「今日ジム何やろう?」「最近どこ鍛えた?」「昨日トレした?」等に答えるため。" +
    "ご主人様が今日のトレ内容を相談してきた時は、必ず range='last' で直近の部位を確認してから提案する (例: 昨日上半身だったので、今日は下半身どうですか?)。" +
    "range: 'last' = 直近 1 件、'recent' = 直近 7 件 (部位の偏り判定)、'today' = 今日の運動。",
  input_schema: {
    type: "object",
    properties: {
      range: {
        type: "string",
        enum: ["last", "recent", "today"],
        description: "参照したい範囲",
      },
    },
    required: ["range"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "health",
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { range?: unknown };
    const { summarizeWorkout } = await import("@/lib/health-summary");
    const range = (typeof i.range === "string" ? i.range : "last") as "last" | "recent" | "today";
    return await summarizeWorkout(range);
  },
};
