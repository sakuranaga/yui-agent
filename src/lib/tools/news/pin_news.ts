import { pinArticle as pinNewsArticle } from "@/lib/news";
import type { ToolDef } from "../types";

export const pinNews: ToolDef = {
  name: "pin_news",
  description:
    "ニュース記事を保存 (pinned 化)。3 日 TTL の自動削除から除外する。" +
    "ご主人様が「このニュース保存しといて」「これとっといて」「ピン留めして」等と言った時に呼ぶ。" +
    "id は list_news の結果に含まれる数値。",
  input_schema: {
    type: "object",
    properties: {
      id: { type: "integer", description: "記事 id" },
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
    const row = await pinNewsArticle(i.id, true);
    if (!row) throw new Error(`article ${i.id} not found`);
    return `pinned|id=${row.id}|title=${row.title.slice(0, 60)}`;
  },
};
