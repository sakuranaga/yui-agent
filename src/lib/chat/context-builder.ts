import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db/client";
import { rawMessages } from "@/db/schema";
import { eq, desc } from "drizzle-orm";
import { chatTimestampMarker } from "@/lib/time";
import type { ToolMode } from "@/lib/tools/types";

export type ClientImage = {
  mediaType: "image/webp" | "image/png" | "image/jpeg" | "image/gif";
  data: string;
};

export type ClientMessage = {
  role: "user" | "assistant";
  content: string;
  images?: ClientImage[];
  /** 過去 assistant ターンで実行した tool 呼び出しサマリ (idempotency 補強用) */
  toolSummary?: Array<{ name: string; brief: string }>;
  /** メッセージの作成時刻 (epoch ms)。 */
  createdAt?: number;
};

export async function loadHistoryTimestamps(args: {
  sessionId: string;
  historyLength: number;
}): Promise<Date[]> {
  if (args.historyLength <= 0) return [];
  try {
    const rows = await db
      .select({ createdAt: rawMessages.createdAt })
      .from(rawMessages)
      .where(eq(rawMessages.sessionId, args.sessionId))
      .orderBy(desc(rawMessages.createdAt), desc(rawMessages.id))
      .limit(args.historyLength);
    return rows.map((r) => new Date(r.createdAt)).reverse();
  } catch (e) {
    console.warn("[chat] history timestamps load failed:", e);
    return [];
  }
}

function escapeRuntimeClose(s: string): string {
  return s.replace(/<\/yui_runtime_context>/gi, "[/yui_runtime_context]");
}

export function buildApiMessages(args: {
  messages: ClientMessage[];
  dynamicContext: string;
  historyTimestamps: Date[];
}): Anthropic.MessageParam[] {
  const RUNTIME_CLOSE = "</yui_runtime_context>";
  const injectRuntimeContext = (userText: string): string => {
    if (!args.dynamicContext) return userText;
    return `<yui_runtime_context>\n${escapeRuntimeClose(args.dynamicContext)}\n${RUNTIME_CLOSE}\n\n${escapeRuntimeClose(userText)}`;
  };

  return args.messages.map((m, idx) => {
    const isCurrent = idx === args.messages.length - 1;
    const tsMs = !isCurrent ? (m.createdAt ?? args.historyTimestamps[idx]?.getTime()) : undefined;
    const ts = tsMs !== undefined ? new Date(tsMs) : undefined;
    const stamp = ts ? `[${chatTimestampMarker(ts)}] ` : "";
    const userText = isCurrent ? injectRuntimeContext(m.content) : `${stamp}${m.content}`;

    if (m.images && m.images.length > 0 && m.role === "user") {
      return {
        role: "user" as const,
        content: [
          ...m.images.map((img) => ({
            type: "image" as const,
            source: {
              type: "base64" as const,
              media_type: img.mediaType,
              data: img.data,
            },
          })),
          { type: "text" as const, text: userText },
        ],
      };
    }
    return { role: m.role, content: userText };
  });
}

export function buildExecutorContext(args: {
  messages: ClientMessage[];
  currentUserMsg: string;
  historyTimestamps: Date[];
  toolMode: ToolMode;
  source: string;
  now?: Date;
}): { recentHistory: Anthropic.MessageParam[]; runtimeFacts: string } {
  const RECENT_HISTORY_TURNS = 3;
  const HISTORY_WINDOW_MINUTES = 5;
  const now = args.now ?? new Date();
  const histCutoffMs = now.getTime() - HISTORY_WINDOW_MINUTES * 60_000;

  const recentHistory: Anthropic.MessageParam[] = args.messages
    .map((m, idx) => ({
      m,
      tsMs: m.createdAt ?? args.historyTimestamps[idx]?.getTime(),
      isCurrent: idx === args.messages.length - 1,
    }))
    .filter(
      ({ m, tsMs, isCurrent }) =>
        !isCurrent &&
        m.role !== "assistant" &&
        (tsMs === undefined || tsMs >= histCutoffMs),
    )
    .slice(-RECENT_HISTORY_TURNS)
    .map(({ m }) => ({
      role: "user" as const,
      content: typeof m.content === "string" ? m.content : String(m.content ?? ""),
    }));

  const lastRH = recentHistory[recentHistory.length - 1];
  if (!lastRH || lastRH.content !== args.currentUserMsg) {
    recentHistory.push({ role: "user", content: args.currentUserMsg });
  }

  const execNoteCutoffMs = now.getTime() - HISTORY_WINDOW_MINUTES * 60_000;
  const recentExecuted = args.messages
    .map((m, idx) => ({ m, tsMs: m.createdAt ?? args.historyTimestamps[idx]?.getTime() }))
    .filter(
      ({ m, tsMs }) =>
        m.role === "assistant" &&
        !!m.toolSummary?.length &&
        (tsMs === undefined || tsMs >= execNoteCutoffMs),
    )
    .flatMap(({ m }) => m.toolSummary!.map((t) => (t.brief ? `${t.name}(${t.brief})` : t.name)));
  const executedNote =
    recentExecuted.length > 0
      ? `\n直近で実行済み (= 既に完了。同じ依頼を再実行/蒸し返さない): ${recentExecuted.join(", ")}`
      : "";

  return {
    recentHistory,
    runtimeFacts:
      [
        `現在時刻: ${chatTimestampMarker(now)}`,
        `mode: ${args.toolMode}`,
        `source: ${args.source}`,
      ].join("\n") + executedNote,
  };
}
