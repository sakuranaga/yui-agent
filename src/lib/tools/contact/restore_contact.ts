import { restoreContact } from "@/lib/contacts";
import type { ToolDef } from "../types";

export const restoreContactTool: ToolDef = {
  name: "restore_contact",
  description: "論理削除した連絡先を復元 (deleted_at クリア)。",
  input_schema: {
    type: "object",
    properties: { identifier: { type: "string" } },
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
    const i = (input ?? {}) as { identifier?: string };
    if (!i.identifier) throw new Error("identifier required");
    const c = await restoreContact(i.identifier);
    return c ? `${c.identifier}|restored` : "not found";
  },
};
