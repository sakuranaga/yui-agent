import { getEffectiveState } from "@/lib/activity";
import { saveImage, type SavedAttachment } from "@/lib/chat-attachments";
import { appendOverlay } from "@/lib/conversation-overlay";
import { writeAssistantMessage, writeRawTurnPair } from "@/lib/memory";
import {
  extractIncremental,
  isSessionEnd,
  pendingExtractionCount,
  ROLLING_THRESHOLD,
} from "@/lib/extract";
import { reconcileNewChunks } from "@/lib/reconcile";
import { summarizeUserImageBg } from "@/lib/image-summary";
import type { ClientImage } from "@/lib/chat/context-builder";

export type ChatSource = "web" | "discord_text" | "discord_voice" | "cron" | "timer";

export async function saveUserImages(args: {
  sessionId: string;
  images: ClientImage[];
  userText: string;
  assistantReply: string;
}): Promise<SavedAttachment[]> {
  const savedAttachments: SavedAttachment[] = [];
  if (args.images.length === 0) return savedAttachments;

  for (const img of args.images) {
    try {
      const saved = await saveImage({
        sessionId: args.sessionId,
        mediaType: img.mediaType,
        base64Data: img.data,
      });
      savedAttachments.push(saved);
    } catch (e) {
      console.warn("[chat] saveImage failed:", e);
    }
  }

  void summarizeUserImageBg({
    sessionId: args.sessionId,
    images: args.images,
    userText: args.userText,
    assistantReply: args.assistantReply,
  });

  return savedAttachments;
}

export async function persistChatTurn(args: {
  sessionId: string;
  source: ChatSource;
  currentUserMsg: string;
  reply: string;
  emotion: string;
  userAttachments: SavedAttachment[];
  executedTools: Array<{ name: string; brief: string }>;
}): Promise<{ isPrivate: boolean }> {
  const effectiveUserState = await getEffectiveState(args.sessionId);
  const isPrivate = effectiveUserState === "private";

  if (isPrivate) {
    const ts = Date.now();
    if (args.source !== "cron" && args.source !== "timer") {
      await appendOverlay(args.sessionId, {
        role: "user",
        content: args.currentUserMsg,
        kind: "private",
        source: args.source,
        ts,
      });
    }
    await appendOverlay(args.sessionId, {
      role: "assistant",
      content: args.reply,
      kind: "private",
      source: args.source,
      emotion: args.emotion,
      ts: ts + 1,
      toolSummary: args.executedTools.length > 0 ? args.executedTools : undefined,
    });
    return { isPrivate };
  }

  if (args.source === "cron" || args.source === "timer") {
    await writeAssistantMessage({
      sessionId: args.sessionId,
      source: args.source,
      content: args.reply,
      emotion: args.emotion,
    });
  } else {
    await writeRawTurnPair({
      sessionId: args.sessionId,
      source: args.source,
      userMsg: args.currentUserMsg,
      assistantMsg: args.reply,
      emotion: args.emotion,
      userAttachments: args.userAttachments,
      assistantToolSummary: args.executedTools,
    });
  }

  return { isPrivate };
}

export async function runPostPersistJobs(args: {
  sessionId: string;
  currentUserMsg: string;
  isPrivate: boolean;
}): Promise<void> {
  if (args.isPrivate) return;

  try {
    const { scheduleExtract } = await import("@/lib/food-extract");
    void scheduleExtract(args.sessionId);
  } catch (e) {
    console.warn("[chat] food extract schedule failed:", e);
  }

  try {
    const { scheduleWorkoutExtract } = await import("@/lib/workout-extract");
    void scheduleWorkoutExtract(args.sessionId);
  } catch (e) {
    console.warn("[chat] workout extract schedule failed:", e);
  }

  try {
    let result: { count: number; newChunkIds: number[] } = {
      count: 0,
      newChunkIds: [],
    };
    if (isSessionEnd(args.currentUserMsg)) {
      result = await extractIncremental({
        sessionId: args.sessionId,
        minMessages: 1,
        provisional: false,
      });
      console.log(`[chat] session-end extraction: ${result.count} items`);
    } else {
      const pending = await pendingExtractionCount(args.sessionId);
      if (pending >= ROLLING_THRESHOLD) {
        result = await extractIncremental({
          sessionId: args.sessionId,
          minMessages: ROLLING_THRESHOLD,
          provisional: true,
        });
        console.log(`[chat] rolling extraction (pending=${pending}): ${result.count} items`);
      }
    }

    if (result.newChunkIds.length > 0) {
      void reconcileNewChunks(result.newChunkIds).catch((e) =>
        console.warn("[chat] reconcile failed:", e),
      );
    }
  } catch (e) {
    console.warn("[chat] extraction failed:", e);
  }
}
