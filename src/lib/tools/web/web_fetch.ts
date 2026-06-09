import { fetchUrl } from "@/lib/tools/web";
import type { ToolDef } from "../types";

export const webFetch: ToolDef = {
  name: "web_fetch",
  description:
    "指定 URL の本文を取得して text として返す。web_search の結果 url か、" +
    "ユーザが提示した URL のみに使う。URL を推測して fetch しない。",
  input_schema: {
    type: "object",
    properties: {
      url: { type: "string", description: "http(s) URL" },
      max_chars: { type: "integer", default: 8000 },
    },
    required: ["url"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "external",
  domain: "web",
  untrustedOutput: true,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { url?: unknown; max_chars?: unknown };
    return await fetchUrl({
      url: String(i.url ?? ""),
      maxChars: typeof i.max_chars === "number" ? i.max_chars : undefined,
    });
  },
};
