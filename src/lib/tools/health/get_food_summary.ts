import type { ToolDef } from "../types";

export const getFoodSummary: ToolDef = {
  name: "get_food_summary",
  description:
    "ご主人様の食事・体重・気分・歩数などのヘルスデータを参照する。" +
    "「今日いくら食べた?」「今週の体重どう?」「最近疲れてる?」「今日何歩歩いた?」など、" +
    "ヘルス関連の質問に答えるために使う。" +
    "range: " +
    "'today' = 今日の食事サマリー、" +
    "'recent_weight' = 直近 7 件の体重推移、" +
    "'recent_mood' = 直近 7 件の気分推移、" +
    "'today_activity' = 今日の歩数 / 活動 kcal / 運動分 / 安静時心拍、" +
    "'recent_steps' = 直近 7 日の歩数推移、" +
    "'recent_hr' = 直近 7 件の安静時心拍。" +
    "返り値はテキストサマリー。",
  input_schema: {
    type: "object",
    properties: {
      range: {
        type: "string",
        enum: ["today", "recent_weight", "recent_mood", "today_activity", "recent_steps", "recent_hr"],
        description: "参照したいデータの種類",
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
    const { summarizeHealth } = await import("@/lib/health-summary");
    const range = (typeof i.range === "string" ? i.range : "today") as
      | "today"
      | "recent_weight"
      | "recent_mood"
      | "today_activity"
      | "recent_steps"
      | "recent_hr";
    return await summarizeHealth(range);
  },
};
