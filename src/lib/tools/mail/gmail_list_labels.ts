import { listLabels } from "@/lib/gmail";
import { isGmailReadonly } from "../availability/google";
import type { ToolDef } from "../types";

export const gmailListLabels: ToolDef = {
  name: "gmail_list_labels",
  description:
    "Gmail のラベル一覧 (システム + ユーザー定義) を取得。" +
    "特定のユーザーラベルでフィルタしたい時、まず ID を引くのに使う。",
  input_schema: {
    type: "object",
    properties: {},
    additionalProperties: false,
  },
  callableBy: [{ kind: "specialist", id: "mail" }],
  surface: "read",
  domain: "mail",
  untrustedOutput: false, // label 名は user 自身が作るので trusted
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  availabilityKey: "google:gmail.readonly",
  isAvailable: isGmailReadonly,
  handler: async () => {
    const labels = await listLabels();
    return {
      count: labels.length,
      labels: labels.map((l) => ({
        id: l.id,
        name: l.name,
        type: l.type,
        unread: l.messagesUnread,
        total: l.messagesTotal,
      })),
    };
  },
};
