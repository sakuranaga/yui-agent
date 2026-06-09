import { appendContactValue } from "@/lib/contacts";
import type { ToolDef } from "../types";

export const appendContactValueTool: ToolDef = {
  name: "append_contact_value",
  description:
    "連絡先の emails / phones / addresses 配列に 1 件追加。重複値は無視。" +
    "「○○さんの携帯追加して」「メール覚えておいて」等で呼ぶ。",
  input_schema: {
    type: "object",
    properties: {
      identifier: { type: "string" },
      field: { type: "string", enum: ["emails", "phones", "addresses"] },
      type: { type: "string", description: "cell/work/home 等 (任意)" },
      value: { type: "string" },
    },
    required: ["identifier", "field", "value"],
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
      field?: "emails" | "phones" | "addresses";
      type?: string;
      value?: string;
    };
    if (!i.identifier || !i.field || !i.value)
      throw new Error("identifier, field, value required");
    const c = await appendContactValue(i.identifier, i.field, {
      type: i.type,
      value: i.value,
    });
    return c ? `${c.identifier}|${i.field} appended` : "not found";
  },
};
