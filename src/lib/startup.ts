/**
 * アプリ起動時 / 一定間隔で実行したい "メンテナンス" タスクを管理する。
 *
 * Next.js には明確な app startup hook がないので、最初のリクエスト時に
 * lazy に発火させる + 一定間隔で再実行する debounce で代用する。
 *
 * Phase G (cron) を入れたらそちらに移行。
 */
import { processStaleSessions } from "@/lib/extract";
import { reconcileNewChunks } from "@/lib/reconcile";
import { rearmAllPending } from "@/lib/timers";
import { startScheduler } from "@/lib/scheduler";
import { pruneExpiredAttachments } from "@/lib/chat-attachments";
import { pruneOldNews } from "@/lib/news";
import { loadLocationFromDb } from "@/lib/location";
import { migrateOAuthTokensToEncrypted } from "@/lib/oauth-token-migrate";
import { seedTtsDictionaryIfEmpty } from "@/lib/tts-dictionary";

const STARTUP_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5分毎に再実行

let initialized = false;
let lastStaleCheckAt = 0;

/**
 * 起動時に1回 (lazy) + 5分以上経過していたら再実行。
 * リクエスト hot path から fire-and-forget で呼ぶ。
 */
export function tickMaintenance(): void {
  const now = Date.now();
  if (initialized && now - lastStaleCheckAt < STARTUP_CHECK_INTERVAL_MS) {
    return;
  }
  const isFirstRun = !initialized;
  initialized = true;
  lastStaleCheckAt = now;

  void (async () => {
    try {
      if (isFirstRun) {
        console.log("[startup] running first maintenance pass");
        // 位置情報を DB から復元 (再起動越え)。weather / 日記の天気が
        // フロントの再 push 前に走っても落ちないようにする。
        try {
          await loadLocationFromDb();
        } catch (e) {
          console.warn("[startup] loadLocationFromDb failed:", e);
        }
        // タイマーの再 arm は first run でだけ実行 (5 分ごとには不要)。
        // setTimeout が DB と同期して動き続ける限り、活性 timer は in-memory 管理で十分。
        try {
          const n = await rearmAllPending();
          if (n > 0) console.log(`[startup] re-armed ${n} pending timer(s)`);
        } catch (e) {
          console.warn("[startup] rearmAllPending failed:", e);
        }
        try {
          startScheduler();
        } catch (e) {
          console.warn("[startup] startScheduler failed:", e);
        }
        // Spotify now-playing は SDK push (player_state_changed → /api/spotify/poll-now) と
        // ENV ブロック生成時の on-demand poll で更新する (定期 polling 撤去済)。
        // 旧スキーマで plaintext のまま入っていた OAuth refresh/access token を
        // ENCRYPTION_KEY で encrypt し直して plaintext 列を NULL に倒す。
        // 失敗しても他の初期化は続ける (= warn のみ)。
        try {
          await migrateOAuthTokensToEncrypted();
        } catch (e) {
          console.warn("[startup] migrateOAuthTokensToEncrypted failed:", e);
        }
        // tts_dictionary が完全空の OSS 配布直後のみ、プリセット (= 3D / AI / GitHub /
        // Apple Music 等) を bulk insert する。ユーザーが削除した entry を復活させない
        // ため、1 件でも存在すれば skip。詳細は seedTtsDictionaryIfEmpty 参照。
        try {
          const r = await seedTtsDictionaryIfEmpty();
          if (r.seeded > 0) {
            console.log(`[startup] tts_dictionary seeded ${r.seeded} preset entries`);
          }
        } catch (e) {
          console.warn("[startup] seedTtsDictionaryIfEmpty failed:", e);
        }
        // モデルレジストリ (#206): 空なら既存 model 設定から移行 seed (idempotent)。
        try {
          const { seedModelRegistryIfEmpty } = await import("@/lib/model-registry");
          const r = await seedModelRegistryIfEmpty();
          if (r.seeded > 0) {
            console.log(`[startup] model_registry seeded ${r.seeded} entries (migration)`);
          }
        } catch (e) {
          console.warn("[startup] seedModelRegistryIfEmpty failed:", e);
        }
        // food_logs.nutrition_status='pending'/'processing' で取り残された行を pickup
        // (= 前回起動中に extractor が INSERT したが worker が完走する前に restart した場合、
        //   または worker が processing にした直後に落ちた場合)
        try {
          const { releaseStuckProcessing, kickFillWorker } = await import("@/lib/food-nutrition-worker");
          await releaseStuckProcessing();
          void kickFillWorker();
        } catch (e) {
          console.warn("[startup] food nutrition worker kick failed:", e);
        }
      }
      const n = await processStaleSessions();
      if (n > 0) {
        console.log(`[startup] stale sessions processed: ${n}`);
      }
      // 1 週間 (TTL) を超えた チャット添付画像をディスクから削除。
      try {
        const r = await pruneExpiredAttachments();
        if (r.deletedFiles > 0) {
          console.log(
            `[startup] pruned chat attachments: ${r.deletedFiles} files / ${r.prunedRows} rows`
          );
        }
      } catch (e) {
        console.warn("[startup] pruneExpiredAttachments failed:", e);
      }
      // 3 日 TTL を超えた pinned=false のニュース記事を削除。
      try {
        const r = await pruneOldNews();
        if (r.deleted > 0) {
          console.log(`[startup] pruned old news articles: ${r.deleted} rows`);
        }
      } catch (e) {
        console.warn("[startup] pruneOldNews failed:", e);
      }
    } catch (e) {
      console.warn("[startup] maintenance failed:", e);
    }
  })();
}

// reconcileNewChunks を再export (chat route から1箇所参照に集約)
export { reconcileNewChunks };
