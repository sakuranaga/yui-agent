import { and, asc, eq, lte, sql as drizzleSql } from "drizzle-orm";
import { db } from "@/db/client";
import { backgroundJobs, type BackgroundJob } from "@/db/schema";

export type BackgroundJobType =
  | "chat.post_persist"
  | "image.summary"
  | "music.prefetch_trivia"
  | "mail.curate";

export async function enqueueBackgroundJob(args: {
  jobType: BackgroundJobType;
  payload: Record<string, unknown>;
  dedupKey?: string;
  priority?: number;
  maxAttempts?: number;
  availableAt?: Date;
}): Promise<BackgroundJob> {
  const inserted = await db
    .insert(backgroundJobs)
    .values({
      jobType: args.jobType,
      payload: args.payload,
      dedupKey: args.dedupKey,
      priority: args.priority ?? 100,
      maxAttempts: args.maxAttempts ?? 3,
      availableAt: args.availableAt ?? new Date(),
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];
  if (!args.dedupKey) {
    throw new Error("background_jobs insert returned no row without dedupKey");
  }
  const [existing] = await db
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.dedupKey, args.dedupKey))
    .limit(1);
  if (!existing) throw new Error(`background_jobs dedup lookup failed: ${args.dedupKey}`);
  return existing;
}

export async function claimNextBackgroundJob(workerId: string): Promise<BackgroundJob | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(backgroundJobs)
      .where(
        and(
          eq(backgroundJobs.status, "pending"),
          lte(backgroundJobs.availableAt, drizzleSql`now()`),
        ),
      )
      .orderBy(asc(backgroundJobs.priority), asc(backgroundJobs.createdAt), asc(backgroundJobs.id))
      .limit(1)
      .for("update", { skipLocked: true });
    if (!row) return null;

    const [claimed] = await tx
      .update(backgroundJobs)
      .set({
        status: "running",
        attempts: drizzleSql`${backgroundJobs.attempts} + 1`,
        lockedAt: new Date(),
        lockedBy: workerId,
        startedAt: row.startedAt ?? new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(backgroundJobs.id, row.id), eq(backgroundJobs.status, "pending")))
      .returning();
    return claimed ?? null;
  });
}

export async function completeBackgroundJob(jobId: number): Promise<void> {
  await db
    .update(backgroundJobs)
    .set({
      status: "succeeded",
      completedAt: new Date(),
      updatedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
    })
    .where(eq(backgroundJobs.id, jobId));
}

export async function failOrRetryBackgroundJob(job: BackgroundJob, error: unknown): Promise<void> {
  const msg = error instanceof Error ? error.message : String(error);
  const willRetry = job.attempts < job.maxAttempts;
  const retryDelayMs = Math.min(60_000, 2_000 * Math.max(1, job.attempts));
  await db
    .update(backgroundJobs)
    .set({
      status: willRetry ? "pending" : "failed",
      availableAt: willRetry ? new Date(Date.now() + retryDelayMs) : job.availableAt,
      completedAt: willRetry ? null : new Date(),
      lastError: msg.slice(0, 2000),
      lockedAt: null,
      lockedBy: null,
      updatedAt: new Date(),
    })
    .where(eq(backgroundJobs.id, job.id));
}
