import { searchDiary, formatDiaryCompact } from "@/lib/diary";
import type { ToolDef } from "../types";

export const searchDiaryTool: ToolDef = {
  name: "search_diary",
  description:
    "日記本文を全文 (ILIKE) 検索。" +
    "「○○のこと書いてたよね?」「ヘビメタの話題が出てた日」等で過去エントリを引く時に使う。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "diary",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { query?: unknown; limit?: unknown };
    const query = typeof i.query === "string" ? i.query : "";
    if (!query) throw new Error("query required");
    const limit = typeof i.limit === "number" ? i.limit : undefined;
    const list = await searchDiary(query, limit);
    return list.length > 0
      ? `count=${list.length}\n${list.map(formatDiaryCompact).join("\n")}`
      : "count=0";
  },
};
