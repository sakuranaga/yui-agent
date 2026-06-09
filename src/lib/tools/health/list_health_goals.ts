import type { ToolDef } from "../types";

export const listHealthGoals: ToolDef = {
  name: "list_health_goals",
  description: "ヘルス目標一覧 (有効中) を返す。会話で「何の目標があったっけ」と聞かれた時用。",
  input_schema: { type: "object", properties: {}, additionalProperties: false },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "health",
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async () => {
    const { evaluateAllEnabled, metricLabel } = await import("@/lib/health-goals");
    const all = await evaluateAllEnabled();
    if (all.length === 0) {
      return "現在、有効な目標は登録されていません。";
    }
    const lines = all.map(({ goal, status }) => {
      const label = goal.label ?? `${metricLabel(goal.metricKey)} ${goal.targetValue}`;
      return `- [id=${goal.id}] ${goal.kind} | ${label} | ${JSON.stringify(status)}`;
    });
    return lines.join("\n");
  },
};
