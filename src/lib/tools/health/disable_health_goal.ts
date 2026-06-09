import type { ToolDef } from "../types";

export const disableHealthGoal: ToolDef = {
  name: "disable_health_goal",
  description: "ヘルス目標を無効化する (= 削除ではなく履歴は残す)。id 必須。",
  input_schema: {
    type: "object",
    properties: { id: { type: "integer" } },
    required: ["id"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "health",
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { id?: unknown };
    const { updateGoal } = await import("@/lib/health-goals");
    if (typeof i.id !== "number") throw new Error("id 必須");
    const g = await updateGoal(i.id, { enabled: false });
    return g ? `id=${g.id} を無効化しました` : "not found";
  },
};
