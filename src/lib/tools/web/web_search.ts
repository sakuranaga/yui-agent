import { searchWeb } from "@/lib/tools/web";
import type { ToolDef } from "../types";

export const webSearch: ToolDef = {
  name: "web_search",
  description:
    "インターネットを検索して、上位の結果 (title / url / snippet) を返す。" +
    "query には日本語 / 英語どちらも可。",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
      limit: { type: "integer", default: 8 },
      categories: {
        type: "string",
        description:
          "任意: general / news / it / files / images / videos / music / science のカンマ区切り",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }, { kind: "specialist", id: "music" }, { kind: "specialist", id: "mail" }, { kind: "specialist", id: "schedule" }, { kind: "specialist", id: "report" }],
  surface: "external",
  domain: "web",
  // 検索結果 snippet は第三者書き込み可能なので untrusted 扱い
  untrustedOutput: true,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { query?: unknown; limit?: unknown; categories?: unknown };
    const hits = await searchWeb({
      query: String(i.query ?? ""),
      limit: typeof i.limit === "number" ? i.limit : undefined,
      categories: typeof i.categories === "string" ? i.categories : undefined,
    });
    return { count: hits.length, hits };
  },
};
