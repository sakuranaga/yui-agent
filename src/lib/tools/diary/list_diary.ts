import { listDiary, formatDiaryCompact } from "@/lib/diary";
import type { ToolDef } from "../types";

export const listDiaryTool: ToolDef = {
  name: "list_diary",
  description: "日記の一覧 (新しい順、compact 1 行)。期間絞り込み可。",
  input_schema: {
    type: "object",
    properties: {
      from: { type: "string", description: "YYYY-MM-DD" },
      to: { type: "string", description: "YYYY-MM-DD" },
      limit: { type: "integer" },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "diary",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { from?: unknown; to?: unknown; limit?: unknown };
    const list = await listDiary({
      from: typeof i.from === "string" ? i.from : undefined,
      to: typeof i.to === "string" ? i.to : undefined,
      limit: typeof i.limit === "number" ? i.limit : undefined,
    });
    return list.length > 0
      ? `count=${list.length}\n${list.map(formatDiaryCompact).join("\n")}`
      : "count=0";
  },
};
