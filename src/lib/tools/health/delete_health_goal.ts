import type { ToolDef } from "../types";

export const deleteHealthGoal: ToolDef = {
  name: "delete_health_goal",
  description: "ヘルス目標を完全削除する。disable では足りない時のみ使う。id 必須。",
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
  confirmationPolicy: "confirm_destructive",
  handler: async (input) => {
    const i = (input ?? {}) as { id?: unknown };
    const { deleteGoal } = await import("@/lib/health-goals");
    if (typeof i.id !== "number") throw new Error("id 必須");
    const ok = await deleteGoal(i.id);
    return ok ? `id=${i.id} を削除しました` : "not found";
  },
};
