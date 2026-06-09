import {
  searchContacts,
  formatContactCompact,
  formatContactDetailMarkdown,
  formatContactListMarkdown,
} from "@/lib/contacts";
import { pushToSession } from "@/lib/jobs/events";
import type { ToolDef } from "../types";

export const searchContactsTool: ToolDef = {
  name: "search_contacts",
  description:
    "名前 / 読み仮名 / 会社 / メール を部分一致検索。" +
    "「青山さん」と曖昧に呼ばれたら最初にこれを呼んで identifier 特定 → find_contact で詳細。",
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
  domain: "contact",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { query?: string; limit?: number };
    if (!i.query) throw new Error("query required");
    const list = await searchContacts(i.query, i.limit);
    const lines = list.map(formatContactCompact);
    // 結果が多数の場合はノートにテーブル表示、1 件なら詳細を表示
    if (list.length === 1) {
      const report = formatContactDetailMarkdown(list[0]);
      pushToSession(ctx.sessionId, {
        type: "report_update",
        jobId: Date.now(),
        title: report.title,
        markdown: report.markdown,
      });
    } else if (list.length > 1) {
      const report = formatContactListMarkdown(list, {
        titleHint: `検索: "${i.query}"`,
      });
      pushToSession(ctx.sessionId, {
        type: "report_update",
        jobId: Date.now(),
        title: report.title,
        markdown: report.markdown,
      });
    }
    return lines.length > 0
      ? `count=${lines.length}\n${lines.join("\n")}`
      : "count=0";
  },
};
