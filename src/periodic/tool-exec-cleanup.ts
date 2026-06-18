/**
 * tool_execution_log の定期 cleanup ジョブ。1 時間ごと。
 * 設計: docs/tool-dedup-and-adding-tools.md (Part A)。
 *
 * (1) backstop: finalize 取りこぼし (handler/confirm 経路の異常終了、TTL 期限切れ等) で
 *     executing / pending_confirmation のまま残った 1h 超の行を failed / cancelled に倒す。
 *     dedup 窓 (10分) は超えているので機能影響は無いが、監査ステータスを正す。
 * (2) retention: dedup 窓を十分超えた行 (24h 超) は不要なので物理削除し table 肥大を防ぐ。
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
          SET status = CASE status WHEN 'executing' THEN 'failed' ELSE 'cancelled' END,
              updated_at = now()
          WHERE status IN ('executing','pending_confirmation')
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
