import { deleteContact } from "@/lib/contacts";
import type { ToolDef } from "../types";

export const deleteContactTool: ToolDef = {
  name: "delete_contact",
  description:
    "連絡先を論理削除 (deleted_at セット、行は残る)。重複統合や不要連絡先の整理に使う。" +
    "誤削除しても restore_contact で復元可能。",
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
  confirmationPolicy: "confirm_destructive",
  handler: async (input) => {
    const i = (input ?? {}) as { identifier?: string };
    if (!i.identifier) throw new Error("identifier required");
    const c = await deleteContact(i.identifier);
    return c ? `${c.identifier}|soft-deleted (restore 可能)` : "not found";
  },
};
