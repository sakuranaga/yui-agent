/**
 * tool_execution_log の定期 cleanup ジョブ。1 時間ごと。
 * 設計: docs/tool-dedup-and-adding-tools.md (Part A)。
 *
 * (1) backstop: 放置された確認ダイアログ (pending_confirmation のまま 1h 超 = ユーザーが
 *     クリックせず TTL 切れ) を cancelled に倒す → 再依頼を妨げない。
 *     **executing は touch しない**: dedup 窓は 24h (reminder/calendar) で、executing が
 *     「実行成功したが finalize 失敗で残留」のケースを 1h で failed に倒すと残り 23h の重複ガードが
 *     抜ける。不確実な executing は「実行済み」側に倒す (mutation の重複を防ぐ安全側) のが正しく、
 *     24h retention 削除に委ねる。
 * (2) retention: dedup 窓を十分超えた行 (24h 超) は不要なので物理削除し table 肥大を防ぐ
 *     (executing 残留も含めここで消える)。
 * LLM は呼ばない (skip 固定)。
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import { sql } from "@/db/client";

const RETENTION_HOURS = 24;
const STALE_RESERVATION_HOURS = 1;

const toolExecCleanup: PeriodicModule = {
  id: "tool-exec-cleanup",
  enabled: true,
  schedule: { kind: "interval", everyMs: 60 * 60_000 }, // 1 時間ごと
  run: async (_ctx: PeriodicContext): Promise<PeriodicResult> => {
    const now = Date.now();
    const staleCutoff = new Date(now - STALE_RESERVATION_HOURS * 3_600_000);
    const retentionCutoff = new Date(now - RETENTION_HOURS * 3_600_000);
    let reaped = 0;
    let deleted = 0;
    try {
      const r1 = await sql<[{ count: string }]>`
        WITH updated AS (
          UPDATE tool_execution_log
          SET status = 'cancelled', updated_at = now()
          WHERE status = 'pending_confirmation'
            AND created_at < ${staleCutoff.toISOString()}::timestamptz
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM updated
      `;
      reaped = parseInt(r1[0].count, 10);
    } catch (e) {
      console.warn("[tool-exec-cleanup] stale reservation reap failed:", e);
    }
    try {
      const r2 = await sql<[{ count: string }]>`
        WITH del AS (
          DELETE FROM tool_execution_log
          WHERE created_at < ${retentionCutoff.toISOString()}::timestamptz
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM del
      `;
      deleted = parseInt(r2[0].count, 10);
    } catch (e) {
      console.warn("[tool-exec-cleanup] delete failed:", e);
    }
    if (reaped > 0 || deleted > 0)
      console.log(`[tool-exec-cleanup] reaped=${reaped}, deleted=${deleted}`);
    return { skip: true, reason: `reaped=${reaped}, deleted=${deleted}` };
  },
};

export default toolExecCleanup;
