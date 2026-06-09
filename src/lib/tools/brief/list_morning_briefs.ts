/**
 * 朝のブリーフィング日付一覧 tool。
 * 過去の brief をどの日付に持っているか確認する用 (markdown 本文は含まない)。
 */
import { listMorningBriefs as listMorningBriefsRepo, briefDateYmd } from "@/lib/morning-briefs";
import type { ToolDef } from "../types";

export const listMorningBriefs: ToolDef = {
  name: "list_morning_briefs",
  description:
    "過去の朝のブリーフィング日付一覧を新しい順に返す (markdown 本文は含まない)。" +
    "「ブリーフいつのがある?」等で呼ぶ。",
  input_schema: {
    type: "object",
    properties: {
      limit: { type: "integer", description: "(任意) 既定 14" },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "brief",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { limit?: unknown };
    const limit = typeof i.limit === "number" ? i.limit : 14;
    const items = await listMorningBriefsRepo(limit);
    return {
      count: items.length,
      entries: items.map((b) => ({
        date: briefDateYmd(b),
        generated_at: b.generatedAt.toISOString(),
      })),
    };
  },
};
