import { and, asc, eq, gt, inArray, isNull, lte, or, sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db/client";
import { proactiveSpeechQueue, proactiveState, type ProactiveSpeechQueueRow } from "@/db/schema";
import { pushDurableToSession } from "@/lib/jobs/outbox";

const ACTIVE_TURN_STALE_MS = Number(process.env.PROACTIVE_TURN_STALE_MS ?? 10 * 60 * 1000);
const DRAIN_LIMIT = Number(process.env.PROACTIVE_TURN_DRAIN_LIMIT ?? 5);

type TurnStateValue = {
  active: boolean;
  startedAt?: string;
  finishedAt?: string;
};

function turnKey(sessionId: string): string {
  return `turn:${sessionId}`;
}

export async function beginUserTurn(sessionId: string): Promise<void> {
  if (process.env.PROACTIVE_TURN_QUEUE_ENABLED === "0") return;
  const value: TurnStateValue = { active: true, startedAt: new Date().toISOString() };
  await db
    .insert(proactiveState)
    .values({ key: turnKey(sessionId), value })
    .onConflictDoUpdate({
      target: proactiveState.key,
      set: {
        value,
        updatedAt: drizzleSql`now()`,
      },
    });
}

export async function finishUserTurn(sessionId: string): Promise<void> {
  if (process.env.PROACTIVE_TURN_QUEUE_ENABLED === "0") return;
  const value: TurnStateValue = { active: false, finishedAt: new Date().toISOString() };
  await db
    .insert(proactiveState)
    .values({ key: turnKey(sessionId), value })
    .onConflictDoUpdate({
      target: proactiveState.key,
      set: {
        value,
        updatedAt: drizzleSql`now()`,
      },
    });
}

export async function isUserTurnActive(sessionId: string): Promise<boolean> {
  if (process.env.PROACTIVE_TURN_QUEUE_ENABLED === "0") return false;
  const [row] = await db
    .select({ value: proactiveState.value, updatedAt: proactiveState.updatedAt })
    .from(proactiveState)
    .where(eq(proactiveState.key, turnKey(sessionId)))
    .limit(1);
  if (!row) return false;
  const value = row.value as Partial<TurnStateValue>;
  if (value.active !== true) return false;
  return Date.now() - row.updatedAt.getTime() <= ACTIVE_TURN_STALE_MS;
}

export async function enqueueCronPrompt(args: {
  sessionId: string;
  prompt: string;
  source?: "cron_prompt" | "timer_prompt";
  priority?: number;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
}): Promise<number> {
  const [row] = await db
    .insert(proactiveSpeechQueue)
    .values({
      sessionId: args.sessionId,
      source: args.source ?? "cron_prompt",
      prompt: args.prompt,
      priority: args.priority ?? 50,
      metadata: args.metadata ?? {},
      expiresAt: args.expiresAt ?? null,
    })
    .returning({ id: proactiveSpeechQueue.id });
  return row.id;
}

export async function enqueueNotificationSpeak(args: {
  sessionId: string;
  text: string;
  emotion?: string;
  priority?: number;
  metadata?: Record<string, unknown>;
  expiresAt?: Date | null;
}): Promise<number> {
  const [row] = await db
    .insert(proactiveSpeechQueue)
    .values({
      sessionId: args.sessionId,
      source: "notification_speak",
      speakText: args.text,
      emotion: args.emotion ?? "neutral",
      priority: args.priority ?? 80,
      metadata: args.metadata ?? {},
      expiresAt: args.expiresAt ?? null,
    })
    .returning({ id: proactiveSpeechQueue.id });
  return row.id;
}

export async function maybeQueueCronPrompt(args: {
  sessionId: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  if (!(await isUserTurnActive(args.sessionId))) return false;
  const id = await enqueueCronPrompt({
    sessionId: args.sessionId,
    prompt: args.prompt,
    metadata: { ...(args.metadata ?? {}), queuedDueTo: "active_turn" },
  });
  console.log(`[proactive] queued_due_to_active_turn id=${id} source=cron_prompt`);
  return true;
}

export async function maybeQueueNotificationSpeak(args: {
  sessionId: string;
  text: string;
  emotion?: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  if (!(await isUserTurnActive(args.sessionId))) return false;
  const id = await enqueueNotificationSpeak({
    sessionId: args.sessionId,
    text: args.text,
    emotion: args.emotion,
    metadata: { ...(args.metadata ?? {}), queuedDueTo: "active_turn" },
  });
  console.log(`[proactive] queued_due_to_active_turn id=${id} source=notification_speak`);
  return true;
}

export async function drainQueuedProactiveSpeech(sessionId: string): Promise<number> {
  if (process.env.PROACTIVE_TURN_QUEUE_ENABLED === "0") return 0;
  if (await isUserTurnActive(sessionId)) return 0;

  const rows = await db.transaction(async (tx) => {
    const claimed = await tx
      .select()
      .from(proactiveSpeechQueue)
      .where(
        and(
          eq(proactiveSpeechQueue.sessionId, sessionId),
          isNull(proactiveSpeechQueue.deliveredAt),
          lte(proactiveSpeechQueue.availableAt, drizzleSql`now()`),
          or(isNull(proactiveSpeechQueue.expiresAt), gt(proactiveSpeechQueue.expiresAt, drizzleSql`now()`)),
        ),
      )
      .orderBy(asc(proactiveSpeechQueue.priority), asc(proactiveSpeechQueue.createdAt), asc(proactiveSpeechQueue.id))
      .limit(DRAIN_LIMIT)
      .for("update", { skipLocked: true });

    if (claimed.length === 0) return [];
    await tx
      .update(proactiveSpeechQueue)
      .set({ deliveredAt: drizzleSql`now()` })
      .where(inArray(proactiveSpeechQueue.id, claimed.map((row) => row.id)));
    return claimed;
  });

  for (const row of rows) {
    await deliverQueuedSpeech(row);
  }
  return rows.length;
}

async function deliverQueuedSpeech(row: ProactiveSpeechQueueRow): Promise<void> {
  if (row.source === "notification_speak") {
    const text = row.speakText?.trim();
    if (!text) return;
    await pushDurableToSession(row.sessionId, {
      type: "yui_message",
      jobId: Date.now(),
      text,
      emotion: row.emotion ?? "neutral",
    }, {
      dedupKey: `proactive:${row.id}:speak`,
    });
    void (async () => {
      try {
        const { appendOverlay } = await import("@/lib/conversation-overlay");
        await appendOverlay(row.sessionId, {
          role: "assistant",
          content: text,
          kind: "ephemeral",
          source: "notification",
        });
      } catch (e) {
        console.warn("[proactive] queued notification overlay tee failed:", e);
      }
    })();
    return;
  }

  const prompt = row.prompt?.trim();
  if (!prompt) return;
  const port = process.env.PORT ?? "3000";
  const url = `http://localhost:${port}/api/chat`;
  const { internalFetch } = await import("@/lib/internal-fetch");
  const res = await internalFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "user", content: prompt }],
      sessionId: row.sessionId,
      source: row.source === "timer_prompt" ? "timer" : "cron",
    }),
  });
  if (!res.ok) {
    console.warn(`[proactive] queued prompt POST returned ${res.status}: ${await res.text().catch(() => "")}`);
  }
}
