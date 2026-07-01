/**
 * Next.js web プロセスの起動フック。`register()` は server boot 時に 1 回だけ走る
 * (公式 instrumentation)。
 *
 * 背景: worker 分離 (v0.4.0) で定期 maintenance を worker に移した結果、web の
 * `tickMaintenance` は `WEB_LEGACY_MAINTENANCE_ENABLED` ゲートで既定 no-op になった。
 * location など「web プロセス固有の in-memory global」はプロセス境界を越えないので、
 * worker が load しても web には反映されない。そこで web が自分のリクエストを捌くのに
 * 必要な process-local 初期化は、ここ (web の正式な起動フック) に集約する。
 *
 * heavy / 定期 / DB 副作用系は worker (src/worker) が持つ。ここは web-local state だけ。
 */
export async function register(): Promise<void> {
  // edge runtime では DB を触らない。node ランタイムのみ。
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    // 位置情報 (globalThis.__vroidLocation) を DB から復元。
    // env block の天気 / /api/weather / web_search 座標 / 日記の天気が
    // ブラウザの再 push を待たずに動くようにする。
    const { loadLocationFromDb } = await import("@/lib/location");
    await loadLocationFromDb();

    // タイマー / アラームの再 arm。timer は in-memory setTimeout + SSE push +
    // localhost /api/chat (onFire) を使うため、SSE を持つ web プロセスが所有する。
    // web restart のたびにここで pending 全件を再スケジュールする (worker では持たない)。
    try {
      const { rearmAllPending } = await import("@/lib/timers");
      const n = await rearmAllPending();
      if (n > 0) console.log(`[instrumentation] re-armed ${n} pending timer(s)`);
    } catch (e) {
      console.warn("[instrumentation] rearmAllPending failed:", e);
    }
  } catch (e) {
    console.warn("[instrumentation] web bootstrap failed:", e);
  }
}
