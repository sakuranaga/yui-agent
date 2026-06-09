import type { ToolDef } from "../types";

export const setHealthGoal: ToolDef = {
  name: "set_health_goal",
  description:
    "ご主人様のヘルス目標を新規登録する。" +
    "kind: 'one_time_by_date' (期限付き到達、例: 65kg by 2026-08-31) / " +
    "'daily_min' (毎日達成下限、例: 10000歩) / " +
    "'daily_max' (毎日超過禁止、例: 食事2000kcal未満)。" +
    "metric_key: weight_kg / body_fat_pct / steps_daily / active_kcal_daily / exercise_min_daily / sleep_hours_daily / distance_km_daily / kcal_daily_total / protein_daily_total / carbs_daily_total / fat_daily_total / fiber_daily_total 等。" +
    "one_time_by_date は deadline (YYYY-MM-DD) 必須。",
  input_schema: {
    type: "object",
    properties: {
      metric_key: { type: "string" },
      kind: { type: "string", enum: ["one_time_by_date", "daily_min", "daily_max"] },
      target_value: { type: "number" },
      deadline: { type: "string", description: "YYYY-MM-DD (one_time_by_date 必須)" },
      label: { type: "string", description: "表示用ラベル (任意、未指定なら自動生成)" },
    },
    required: ["metric_key", "kind", "target_value"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "health",
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as {
      metric_key?: unknown;
      kind?: unknown;
      target_value?: unknown;
      deadline?: unknown;
      label?: unknown;
    };
    const { createGoal } = await import("@/lib/health-goals");
    if (typeof i.metric_key !== "string" || typeof i.kind !== "string" || typeof i.target_value !== "number") {
      throw new Error("metric_key / kind / target_value 必須");
    }
    const kind = i.kind as "one_time_by_date" | "daily_min" | "daily_max";
    const g = await createGoal({
      metric_key: i.metric_key,
      kind,
      target_value: i.target_value,
      deadline: typeof i.deadline === "string" ? i.deadline : null,
      label: typeof i.label === "string" ? i.label : null,
    });
    return `登録しました (id=${g.id}, ${g.metricKey} ${g.kind} target=${g.targetValue})`;
  },
};
