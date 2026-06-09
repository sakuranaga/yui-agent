import { appendContactNote } from "@/lib/contacts";
import type { ToolDef } from "../types";

export const appendContactNoteTool: ToolDef = {
  name: "append_contact_note",
  description:
    "連絡先の notes 末尾に日付付き 1 エントリを追記 (last_contact_at も自動更新)。" +
    "ユーザーが人物と関わった話をしたとき (「青山さんに会った」「田中さんから電話」「鈴木さん最近忙しそう」等) に積極的に呼ぶ。" +
    "Yui の重要な仕事: 交友関係の流れを蓄積する。",
  input_schema: {
    type: "object",
    properties: {
      identifier: { type: "string", description: "C-N or 完全名" },
      entry: { type: "string", description: "今日のメモ本文 (1-3 行)" },
      at: { type: "string", description: "YYYY-MM-DD (省略時は今日)" },
    },
    required: ["identifier", "entry"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "contact",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { identifier?: string; entry?: string; at?: string };
    if (!i.identifier || !i.entry) throw new Error("identifier and entry required");
    const c = await appendContactNote({
      identifier: i.identifier,
      entry: i.entry,
      at: i.at ? new Date(i.at) : undefined,
    });
    return c
      ? `${c.identifier}|note appended (last_contact_at updated)`
      : "not found";
  },
};
