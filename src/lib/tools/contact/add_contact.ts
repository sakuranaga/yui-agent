import { addContact, formatContactCompact, type ContactValue } from "@/lib/contacts";
import type { ToolDef } from "../types";

export const addContactTool: ToolDef = {
  name: "add_contact",
  description:
    "連絡先 / 人物を新規登録。ご主人様の交友関係・取引先・知人を Yui の内部 CRM に記録。" +
    "identifier (例: 'C-7') が自動採番されて返る。" +
    "必須: name。任意: kana / nickname / company / department / role / emails / phones / addresses / urls / birthday(YYYY-MM-DD) / tags / notes。" +
    "emails/phones/addresses は配列 ([{type:'cell',value:'090-...'}, ...])。type は cell/work/home/mobile 等。" +
    "新しく名前が出てきたら積極的に登録。",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "氏名 (必須)" },
      kana: { type: "string", description: "フリガナ (検索性向上)" },
      nickname: { type: "string" },
      company: { type: "string" },
      department: { type: "string" },
      role: { type: "string", description: "肩書き / 役職 / 関係性" },
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
      birthday: { type: "string", description: "YYYY-MM-DD" },
      tags: { type: "array", items: { type: "string" } },
      notes: { type: "string", description: "初期メモ" },
    },
    required: ["name"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "contact",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
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
    if (!i.name) throw new Error("name required");
    const c = await addContact({
      sessionId: ctx.sessionId,
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
    return formatContactCompact(c);
  },
};
