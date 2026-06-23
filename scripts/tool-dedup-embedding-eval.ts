import assert from "node:assert/strict";
import { sql } from "@/db/client";
import { dedupCheckAndReserve, finalizeReservation } from "@/lib/tools/dedup-guard";
import { gcalCreateEvent } from "@/lib/tools/schedule/gcal_create_event";
import type { ToolContext } from "@/lib/tools/types";

type LogRow = {
  id: number;
  status: string;
  title_text: string;
  embedding_model: string | null;
};

const runId = `dedup-embed-eval-${Date.now()}`;
const calendarId = runId;
const scopeKey = `calendar:${calendarId}`;
const start = "2026-06-24T13:00:00+09:00";
const end = "2026-06-24T14:00:00+09:00";

function ctx(): ToolContext {
  return {
    sessionId: runId,
    caller: { kind: "specialist", id: "schedule" },
    mode: "normal",
    userUtterance: null,
    availabilityCache: new Map(),
  };
}

function eventInput(summary: string) {
  return {
    calendar_id: calendarId,
    summary,
    start: { dateTime: start, timeZone: "Asia/Tokyo" },
    end: { dateTime: end, timeZone: "Asia/Tokyo" },
  };
}

async function cleanup() {
  await sql`DELETE FROM tool_execution_log WHERE scope_key = ${scopeKey}`;
}

async function rows(): Promise<LogRow[]> {
  return sql<LogRow[]>`
    SELECT id, status, title_text, embedding_model
    FROM tool_execution_log
    WHERE scope_key = ${scopeKey}
    ORDER BY id ASC
  `;
}

async function main() {
  try {
    await cleanup();

    const base = await dedupCheckAndReserve(
      gcalCreateEvent,
      eventInput("岡谷との予定"),
      ctx(),
      "executing",
    );
    assert.deepEqual(base?.duplicate, false);
    assert.ok(base && !base.duplicate && base.reservationId > 0);
    await finalizeReservation(base.reservationId, "executed");

    const variant = await dedupCheckAndReserve(
      gcalCreateEvent,
      eventInput("岡谷に行く予定"),
      ctx(),
      "executing",
    );
    assert.deepEqual(variant?.duplicate, true);

    const distinct = await dedupCheckAndReserve(
      gcalCreateEvent,
      eventInput("13時 ランチ"),
      ctx(),
      "executing",
    );
    assert.deepEqual(distinct?.duplicate, false);
    assert.ok(distinct && !distinct.duplicate && distinct.reservationId > 0);

    const logRows = await rows();
    const executed = logRows.filter((r) => r.status === "executed");
    const executing = logRows.filter((r) => r.status === "executing");
    const skipped = logRows.filter((r) => r.status === "skipped");

    assert.equal(executed.length, 1);
    assert.equal(skipped.length, 1);
    assert.equal(executing.length, 1);
    assert.ok(logRows.every((r) => r.embedding_model));
    assert.equal(executed[0].title_text, "岡谷との予定");
    assert.equal(skipped[0].title_text, "岡谷に行く予定");
    assert.equal(executing[0].title_text, "13時 ランチ");

    console.log("Tool dedup embedding eval");
    console.log("ok - semantic variant was skipped by embedding dedup");
    console.log("ok - distinct title at same anchor was allowed");
    console.log(`ok - fixture rows: executed=${executed.length} skipped=${skipped.length} executing=${executing.length}`);
  } finally {
    await cleanup();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 1 });
    process.exit(process.exitCode ?? 0);
  });
