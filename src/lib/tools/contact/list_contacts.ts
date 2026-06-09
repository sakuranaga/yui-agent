import {
  listContacts,
  formatContactCompact,
  formatContactListMarkdown,
} from "@/lib/contacts";
import { pushToSession } from "@/lib/jobs/events";
import type { ToolDef } from "../types";

export const listContactsTool: ToolDef = {
  name: "list_contacts",
  description:
    "連絡先一覧 (最近やりとり順)。tag / company で絞り込み可。compact 1 行表示。",
  input_schema: {
    type: "object",
    properties: {
      tag: { type: "string" },
      company: { type: "string" },
      limit: { type: "integer" },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "contact",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { tag?: string; company?: string; limit?: number };
    const list = await listContacts({
      tag: i.tag,
      company: i.company,
      limit: i.limit,
    });
    const lines = list.map(formatContactCompact);
    if (list.length > 0) {
      const titleHint = i.tag
        ? `連絡先 tag: ${i.tag}`
        : i.company
          ? `連絡先 company: ${i.company}`
          : "連絡先一覧";
      const report = formatContactListMarkdown(list, { titleHint });
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
