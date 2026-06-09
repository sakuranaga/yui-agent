/**
 * Gmail 検索 (specialist 内部 tool)。
 * snippet が含まれるため untrustedOutput: true。
 */
import { searchMessageSummaries, type GmailMessageSummary } from "@/lib/gmail";
import { isGmailReadonly } from "../availability/google";
import type { ToolDef } from "../types";

function summarize(m: GmailMessageSummary): Record<string, unknown> {
  let dateIso: string | undefined;
  try {
    const ms = parseInt(m.internalDate, 10);
    if (Number.isFinite(ms)) dateIso = new Date(ms).toISOString();
  } catch {
    /* noop */
  }
  return {
    id: m.id,
    thread_id: m.threadId,
    from: m.from,
    subject: m.subject ?? "(no subject)",
    date: dateIso ?? m.date,
    snippet: m.snippet,
    labels: m.labelIds,
  };
}

export const gmailSearch: ToolDef = {
  name: "gmail_search",
  description:
    "Gmail を検索して、各メッセージの差出人/件名/受信日時/snippet を返します。" +
    "query は Gmail Search 構文 (例: 'is:unread', 'from:foo@example.com', 'after:2026/05/20 has:attachment')。" +
    "query 省略時は最近の inbox。",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "Gmail 検索クエリ。is:unread / from: / to: / subject: / after: / before: / label: / has: 等が使える。",
      },
      max_results: { type: "integer", default: 10 },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "specialist", id: "mail" }],
  surface: "read",
  domain: "mail",
  untrustedOutput: true,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  availabilityKey: "google:gmail.readonly",
  isAvailable: isGmailReadonly,
  handler: async (input) => {
    const i = (input ?? {}) as { query?: unknown; max_results?: unknown };
    const results = await searchMessageSummaries({
      q: typeof i.query === "string" ? i.query : undefined,
      maxResults: typeof i.max_results === "number" ? i.max_results : undefined,
    });
    return {
      count: results.length,
      messages: results.map(summarize),
    };
  },
};
