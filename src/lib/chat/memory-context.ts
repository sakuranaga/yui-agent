import {
  buildQueryText,
  formatMemoryPrompt,
  loadAlwaysOnFacts,
  loadRecentSummaries,
  retrieveRelevant,
} from "@/lib/memory";
import type { ClientMessage } from "@/lib/chat/context-builder";

const RETRIEVAL_TOP_K = parseInt(process.env.RETRIEVAL_TOP_K ?? "5", 10);

export type BuiltMemoryContext = {
  memorySection: string;
  counts: {
    alwaysOn: number;
    recentSummaries: number;
    relevant: number;
  };
  retrieveMs: number;
};

export async function buildMemoryContext(args: {
  sessionId: string;
  history: ClientMessage[];
  currentUserMsg: string;
}): Promise<BuiltMemoryContext> {
  const queryText = buildQueryText(args.history, args.currentUserMsg);
  const tRetrieveStart = Date.now();

  try {
    const [alwaysOnFacts, recentSummaries] = await Promise.all([
      loadAlwaysOnFacts({ limit: 10, sessionId: args.sessionId }),
      loadRecentSummaries({ limit: 3, sessionId: args.sessionId }),
    ]);
    const excludeIds = [
      ...alwaysOnFacts.map((f) => f.id),
      ...recentSummaries.map((s) => s.id),
    ];
    const retrieved = await retrieveRelevant({
      queryText,
      currentSessionId: args.sessionId,
      limit: RETRIEVAL_TOP_K,
      excludeIds,
    });

    return {
      memorySection: formatMemoryPrompt({
        alwaysOnFacts,
        recentSummaries,
        relevantChunks: retrieved,
      }),
      counts: {
        alwaysOn: alwaysOnFacts.length,
        recentSummaries: recentSummaries.length,
        relevant: retrieved.length,
      },
      retrieveMs: Date.now() - tRetrieveStart,
    };
  } catch (e) {
    // DB 未起動や embedding 失敗でも chat は継続可能にする。
    console.warn("[chat] retrieval failed:", e);
    return {
      memorySection: "",
      counts: {
        alwaysOn: 0,
        recentSummaries: 0,
        relevant: 0,
      },
      retrieveMs: Date.now() - tRetrieveStart,
    };
  }
}
