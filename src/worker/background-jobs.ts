import { setTimeout as sleep } from "node:timers/promises";
import type { BackgroundJob } from "@/db/schema";
import {
  claimNextBackgroundJob,
  completeBackgroundJob,
  failOrRetryBackgroundJob,
} from "@/lib/jobs/background";
import { runPostPersistJobsNow } from "@/lib/chat/persistence";
import { summarizeUserImageBg } from "@/lib/image-summary";
import { fetchTrackTrivia } from "@/lib/music-trivia";
import { curateMails } from "@/lib/mail-curate";

const ENABLED = process.env.WORKER_BACKGROUND_JOBS_ENABLED !== "0";
const POLL_INTERVAL_MS = Number(process.env.WORKER_BACKGROUND_JOBS_POLL_INTERVAL_MS ?? 1_000);
const IDLE_LOG_INTERVAL_MS = Number(process.env.WORKER_BACKGROUND_JOBS_IDLE_LOG_INTERVAL_MS ?? 60_000);

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function runBackgroundJob(job: BackgroundJob): Promise<void> {
  const payload = asRecord(job.payload);
  switch (job.jobType) {
    case "chat.post_persist": {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const currentUserMsg =
        typeof payload.currentUserMsg === "string" ? payload.currentUserMsg : "";
      if (!sessionId) throw new Error("chat.post_persist payload missing sessionId");
      await runPostPersistJobsNow({
        sessionId,
        currentUserMsg,
        isPrivate: false,
      });
      return;
    }
    case "image.summary": {
      const sessionId = typeof payload.sessionId === "string" ? payload.sessionId : "";
      const userText = typeof payload.userText === "string" ? payload.userText : "";
      const assistantReply =
        typeof payload.assistantReply === "string" ? payload.assistantReply : "";
      const images = Array.isArray(payload.images) ? payload.images : [];
      if (!sessionId) throw new Error("image.summary payload missing sessionId");
      await summarizeUserImageBg({
        sessionId,
        images: images.filter(
          (img): img is {
            mediaType: "image/webp" | "image/png" | "image/jpeg" | "image/gif";
            data: string;
          } => {
            const r = asRecord(img);
            return (
              typeof r.data === "string" &&
              (r.mediaType === "image/webp" ||
                r.mediaType === "image/png" ||
                r.mediaType === "image/jpeg" ||
                r.mediaType === "image/gif")
            );
          },
        ),
        userText,
        assistantReply,
      });
      return;
    }
    case "music.prefetch_trivia": {
      const title = typeof payload.title === "string" ? payload.title : "";
      const artist = typeof payload.artist === "string" ? payload.artist : null;
      const trackUri = typeof payload.trackUri === "string" ? payload.trackUri : null;
      if (!title.trim()) throw new Error("music.prefetch_trivia payload missing title");
      await fetchTrackTrivia(title, artist, trackUri);
      return;
    }
    case "mail.curate": {
      const ids = Array.isArray(payload.ids)
        ? payload.ids.filter((id): id is number => Number.isInteger(id))
        : [];
      if (ids.length === 0) return;
      await curateMails(ids);
      return;
    }
    default:
      throw new Error(`unknown background job type: ${job.jobType}`);
  }
}

export function startBackgroundJobLoop(opts: {
  workerId: string;
  shouldStop: () => boolean;
}): void {
  if (!ENABLED) {
    console.log("[worker:jobs] disabled by WORKER_BACKGROUND_JOBS_ENABLED=0");
    return;
  }

  void (async () => {
    let lastIdleLogAt = 0;
    console.log(`[worker:jobs] loop started poll=${POLL_INTERVAL_MS}ms`);

    while (!opts.shouldStop()) {
      try {
        const job = await claimNextBackgroundJob(opts.workerId);
        if (job) {
          console.log(`[worker:jobs] claimed job ${job.id} type=${job.jobType}`);
          try {
            await runBackgroundJob(job);
            await completeBackgroundJob(job.id);
          } catch (e) {
            console.warn(`[worker:jobs] job ${job.id} failed:`, e);
            await failOrRetryBackgroundJob(job, e);
          }
          continue;
        }

        const now = Date.now();
        if (now - lastIdleLogAt > IDLE_LOG_INTERVAL_MS) {
          lastIdleLogAt = now;
          console.log("[worker:jobs] idle");
        }
      } catch (e) {
        console.warn("[worker:jobs] loop error:", e);
      }
      await sleep(POLL_INTERVAL_MS);
    }

    console.log("[worker:jobs] loop stopped");
  })();
}
