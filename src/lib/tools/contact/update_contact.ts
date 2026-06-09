import { updateContact, formatContactCompact, type ContactValue } from "@/lib/contacts";
import type { ToolDef } from "../types";

export const updateContactTool: ToolDef = {
  name: "update_contact",
  description:
    "連絡先の属性を更新 (notes / emails / phones / addresses はそのフィールドを全置換)。" +
    "1 件だけ追加したい場合は append_contact_value、" +
    "やりとり記録は append_contact_note を使う。",
  input_schema: {
    type: "object",
    properties: {
      identifier: { type: "string", description: "C-N or 完全名" },
      name: { type: "string" },
      kana: { type: "string" },
      nickname: { type: "string" },
      company: { type: "string" },
      department: { type: "string" },
      role: { type: "string" },
      emails: {
        type: "array",
        items: {
          type: "object",
          properties: { type: { type: "string" }, value: { type: "string" } },
          required: ["value"],
        },
      },
      phones: {
        type: "array",
        items: {
          type: "object",
          properties: { type: { type: "string" }, value: { type: "string" } },
          required: ["value"],
        },
      },
      addresses: {
        type: "array",
        items: {
          type: "object",
          properties: { type: { type: "string" }, value: { type: "string" } },
          required: ["value"],
        },
      },
      urls: { type: "array", items: { type: "string" } },
      birthday: { type: "string" },
      tags: { type: "array", items: { type: "string" } },
      notes: { type: "string" },
    },
    required: ["identifier"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "contact",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as {
      identifier?: string;
      name?: string;
      kana?: string;
      nickname?: string;
      company?: string;
      department?: string;
      role?: string;
      emails?: ContactValue[];
      phones?: ContactValue[];
      addresses?: ContactValue[];
      urls?: string[];
      birthday?: string;
      tags?: string[];
      notes?: string;
    };
    if (!i.identifier) throw new Error("identifier required");
    const c = await updateContact({
      identifier: i.identifier,
      name: i.name,
      kana: i.kana,
      nickname: i.nickname,
      company: i.company,
      department: i.department,
      role: i.role,
      emails: i.emails,
      phones: i.phones,
      addresses: i.addresses,
      urls: i.urls,
      birthday: i.birthday ? new Date(i.birthday) : undefined,
      tags: i.tags,
      notes: i.notes,
    });
    return c ? formatContactCompact(c) : "not found";
  },
};
