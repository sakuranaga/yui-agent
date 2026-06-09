import { getContactByIdentifier, formatContactDetailMarkdown } from "@/lib/contacts";
import { pushToSession } from "@/lib/jobs/events";
import type { ToolDef } from "../types";

export const findContactTool: ToolDef = {
  name: "find_contact",
  description:
    "連絡先 1 件の詳細 (notes 全文含む) を取得。" +
    "「青山さんって誰?」「田中部長について教えて」等で呼ぶ。identifier は C-N or 名前完全一致。",
  input_schema: {
    type: "object",
    properties: { identifier: { type: "string" } },
    required: ["identifier"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "contact",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as { identifier?: string };
    if (!i.identifier) throw new Error("identifier required");
    const c = await getContactByIdentifier(i.identifier);
    if (!c) return "not found";
    // ノートパネルにも詳細 markdown を流す
    const report = formatContactDetailMarkdown(c);
    pushToSession(ctx.sessionId, {
      type: "report_update",
      jobId: Date.now(),
      title: report.title,
      markdown: report.markdown,
    });
    return {
      identifier: c.identifier,
      name: c.name,
      kana: c.kana,
      nickname: c.nickname,
      company: c.company,
      department: c.department,
      role: c.role,
      emails: c.emails,
      phones: c.phones,
      addresses: c.addresses,
      urls: c.urls,
      birthday: c.birthday?.toISOString().slice(0, 10) ?? null,
      tags: c.tags,
      notes: c.notes,
      last_contact_at: c.lastContactAt?.toISOString() ?? null,
      created_at: c.createdAt.toISOString(),
    };
  },
};
