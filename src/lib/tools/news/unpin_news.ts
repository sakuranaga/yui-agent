import { pinArticle as pinNewsArticle } from "@/lib/news";
import type { ToolDef } from "../types";

export const unpinNews: ToolDef = {
  name: "unpin_news",
  description:
    "保存解除。pinned=false にして通常の 3 日 TTL に戻す。" +
    "ご主人様が「あのニュース保存解除して」「もういらない」等と言った時に呼ぶ。",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "integer" },
    },
    required: ["id"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "news",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { id?: unknown };
    if (typeof i.id !== "number") throw new Error("id required");
    const row = await pinNewsArticle(i.id, false);
    if (!row) throw new Error(`article ${i.id} not found`);
    return `unpinned|id=${row.id}`;
  },
};
