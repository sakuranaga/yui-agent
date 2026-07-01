/**
 * events_outbox / event delivery の retention cleanup。
 *
 * event_deliveries は events_outbox の ON DELETE CASCADE で落ちる。
 * event_clients は browser tab / discord bot ごとの replay baseline なので、
 * 長期間見ていない client だけ別 retention で掃除する。
 */
import type { PeriodicContext, PeriodicModule, PeriodicResult } from "./types";
import { sql } from "@/db/client";

const OUTBOX_RETENTION_DAYS = Number(process.env.EVENTS_OUTBOX_RETENTION_DAYS ?? 7);
const CLIENT_RETENTION_DAYS = Number(process.env.EVENT_CLIENT_RETENTION_DAYS ?? 30);

const eventsOutboxCleanup: PeriodicModule = {
  id: "events-outbox-cleanup",
  enabled: true,
  schedule: { kind: "interval", everyMs: 6 * 60 * 60_000 }, // 6 時間ごと
  run: async (_ctx: PeriodicContext): Promise<PeriodicResult> => {
    const now = Date.now();
    const outboxCutoff = new Date(now - OUTBOX_RETENTION_DAYS * 24 * 3_600_000);
    const clientCutoff = new Date(now - CLIENT_RETENTION_DAYS * 24 * 3_600_000);
    let expiredDeleted = 0;
    let retentionDeleted = 0;
    let clientDeleted = 0;

    try {
      const r = await sql<[{ count: string }]>`
        WITH del AS (
          DELETE FROM events_outbox
          WHERE expires_at IS NOT NULL
            AND expires_at < now()
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM del
      `;
      expiredDeleted = parseInt(r[0].count, 10);
    } catch (e) {
      console.warn("[events-outbox-cleanup] expired delete failed:", e);
    }

    try {
      const r = await sql<[{ count: string }]>`
        WITH del AS (
          DELETE FROM events_outbox
          WHERE created_at < ${outboxCutoff.toISOString()}::timestamptz
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM del
      `;
      retentionDeleted = parseInt(r[0].count, 10);
    } catch (e) {
      console.warn("[events-outbox-cleanup] retention delete failed:", e);
    }

    try {
      const r = await sql<[{ count: string }]>`
        WITH del AS (
          DELETE FROM event_clients
          WHERE updated_at < ${clientCutoff.toISOString()}::timestamptz
          RETURNING 1
        )
        SELECT COUNT(*)::text AS count FROM del
      `;
      clientDeleted = parseInt(r[0].count, 10);
    } catch (e) {
      console.warn("[events-outbox-cleanup] client delete failed:", e);
    }

    if (expiredDeleted > 0 || retentionDeleted > 0 || clientDeleted > 0) {
      console.log(
        `[events-outbox-cleanup] expired=${expiredDeleted}, retention=${retentionDeleted}, clients=${clientDeleted}`,
      );
    }
    return {
      skip: true,
      reason: `expired=${expiredDeleted}, retention=${retentionDeleted}, clients=${clientDeleted}`,
    };
  },
};

export default eventsOutboxCleanup;
