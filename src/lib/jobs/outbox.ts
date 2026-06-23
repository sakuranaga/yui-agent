import Redis from "ioredis";
import { and, asc, eq, gt, inArray, isNull, lte, or, sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db/client";
import { eventsOutbox, type EventsOutboxRow } from "@/db/schema";
import type { ServerEvent } from "@/lib/jobs/events";

const VALKEY_URL = process.env.VALKEY_URL ?? "redis://valkey:6379";
const CHANNEL = "vroid:events_outbox:wake";
const DRAIN_LIMIT = Number(process.env.EVENTS_OUTBOX_DRAIN_LIMIT ?? 50);

let publisher: Redis | null = null;

function getPublisher(): Redis {
  if (publisher) return publisher;
  publisher = new Redis(VALKEY_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  publisher.on("error", (err) => {
    console.warn("[events-outbox] valkey publisher error:", err.message);
  });
  return publisher;
}

export async function pushDurableToSession(
  sessionId: string,
  event: ServerEvent,
  opts?: {
    dedupKey?: string;
    priority?: number;
    sourceJobId?: string;
    expiresAt?: Date | null;
  },
): Promise<number> {
  await appendOutboxEvent(sessionId, event, opts);
  await publishWake(sessionId);
  return 0;
}

export async function appendOutboxEvent(
  sessionId: string,
  event: ServerEvent,
  opts?: {
    dedupKey?: string;
    priority?: number;
    sourceJobId?: string;
    expiresAt?: Date | null;
  },
): Promise<EventsOutboxRow> {
  const values = {
    sessionId,
    eventType: event.type,
    payload: event as unknown as Record<string, unknown>,
    dedupKey: opts?.dedupKey,
    priority: opts?.priority ?? 100,
    sourceJobId: opts?.sourceJobId,
    expiresAt: opts?.expiresAt ?? null,
  };
  const inserted = await db
    .insert(eventsOutbox)
    .values(values)
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  if (!opts?.dedupKey) {
    throw new Error("events_outbox insert returned no row without dedupKey");
  }
  const [existing] = await db
    .select()
    .from(eventsOutbox)
    .where(eq(eventsOutbox.dedupKey, opts.dedupKey))
    .limit(1);
  if (!existing) throw new Error(`events_outbox dedup lookup failed: ${opts.dedupKey}`);
  return existing;
}

export async function drainOutboxForSession(
  sessionId: string,
  send: (event: ServerEvent) => boolean,
): Promise<number> {
  return db.transaction(async (tx) => {
    const claimed = await tx
      .select()
      .from(eventsOutbox)
      .where(
        and(
          eq(eventsOutbox.sessionId, sessionId),
          isNull(eventsOutbox.deliveredAt),
          lte(eventsOutbox.availableAt, drizzleSql`now()`),
          or(isNull(eventsOutbox.expiresAt), gt(eventsOutbox.expiresAt, drizzleSql`now()`)),
        ),
      )
      .orderBy(asc(eventsOutbox.priority), asc(eventsOutbox.createdAt), asc(eventsOutbox.id))
      .limit(DRAIN_LIMIT)
      .for("update", { skipLocked: true });

    const deliveredIds: number[] = [];
    for (const row of claimed) {
      const ok = send(row.payload as unknown as ServerEvent);
      if (ok) deliveredIds.push(row.id);
    }
    if (deliveredIds.length > 0) {
      await tx
        .update(eventsOutbox)
        .set({ deliveredAt: drizzleSql`now()` })
        .where(inArray(eventsOutbox.id, deliveredIds));
    }
    return deliveredIds.length;
  });
}

export function subscribeOutboxWake(
  sessionId: string,
  onWake: () => void,
): () => void {
  const subscriber = new Redis(VALKEY_URL, {
    lazyConnect: false,
    maxRetriesPerRequest: null,
  });
  let closed = false;
  subscriber.on("message", (_channel, message) => {
    if (closed) return;
    if (message === sessionId || message === "*") onWake();
  });
  subscriber.on("error", (err) => {
    console.warn("[events-outbox] valkey subscriber error:", err.message);
  });
  void subscriber.subscribe(CHANNEL).catch((e) => {
    console.warn("[events-outbox] subscribe failed:", e);
  });
  return () => {
    closed = true;
    void subscriber.quit().catch(() => subscriber.disconnect());
  };
}

async function publishWake(sessionId: string): Promise<void> {
  try {
    const client = getPublisher();
    if (client.status === "wait") await client.connect();
    await client.publish(CHANNEL, sessionId);
  } catch (e) {
    console.warn("[events-outbox] wake publish failed:", e);
  }
}
