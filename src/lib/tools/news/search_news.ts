/**
 * ニュース keyword 検索。
 * 結果に第三者のタイトル/概要が含まれるため untrustedOutput: true。
 */
import { listArticles as listNewsArticles } from "@/lib/news";
import type { ToolDef } from "../types";

export const searchNews: ToolDef = {
  name: "search_news",
  description:
    "ニュースの title / summary をキーワード検索 (ILIKE)。" +
    "「○○のニュース見た?」「△△ について何か出てる?」等で呼ぶ。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", description: "(任意) 既定 20" },
    },
    required: ["query"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "news",
  untrustedOutput: true,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { query?: unknown; limit?: unknown };
    const query = typeof i.query === "string" ? i.query : "";
    if (!query) throw new Error("query required");
    const limit = typeof i.limit === "number" ? i.limit : 20;
    const items = await listNewsArticles({
      query,
      limit,
    });
    return {
      count: items.length,
      articles: items.map((a) => ({
        id: a.id,
        source: a.sourceName,
        title: a.title,
        summary: a.summary?.slice(0, 240),
        link: a.link,
        published_at: a.publishedAt.toISOString(),
        pinned: a.pinned,
      })),
    };
  },
};
