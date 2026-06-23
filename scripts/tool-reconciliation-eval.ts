import assert from "node:assert/strict";
import { sql } from "@/db/client";
import {
  applySafeReconciliationFixes,
  collectReconciliationIssues,
  type ReconciliationIssue,
} from "./tool-reconciliation-report";

const runId = `tool-reconcile-eval-${Date.now()}`;
const sessionId = `${runId}-session`;
const oldTs = new Date(Date.now() - 3 * 60 * 60_000).toISOString();
const historicalTs = new Date(Date.now() - 48 * 60 * 60_000).toISOString();

function countKind(issues: ReconciliationIssue[], kind: ReconciliationIssue["kind"]): number {
  return issues.filter((i) => i.kind === kind).length;
}

function hasError(issues: ReconciliationIssue[]): boolean {
  return issues.some((issue) => issue.severity === "error");
}

const evalOptions = {
  pendingMinutes: 60,
  orphanPendingMinutes: 5,
  executingMinutes: 60,
  runningTaskMinutes: 30,
  confirmFinalGraceMinutes: 2,
  confirmFinalLookbackHours: 24,
  sessionIdPrefix: runId,
};

async function seedFixtures() {
  await sql`
    INSERT INTO tool_execution_log
      (scope_key, tool_name, dedup_anchor, title_text, status, confirm_token, args, created_at, updated_at)
    VALUES
      (${sessionId}, 'gcal_create_event', '2026-06-24T11:00:00+09:00', ${`${runId} stale pending`}, 'pending_confirmation', ${`${runId}-pending-token`}, ${JSON.stringify({ runId })}::jsonb, ${oldTs}, ${oldTs}),
      (${sessionId}, 'gcal_delete_event', '2026-06-24T12:00:00+09:00', ${`${runId} orphan pending`}, 'pending_confirmation', NULL, ${JSON.stringify({ runId })}::jsonb, ${oldTs}, ${oldTs}),
      (${sessionId}, 'gcal_create_event', '2026-06-24T13:00:00+09:00', ${`${runId} stale executing`}, 'executing', NULL, ${JSON.stringify({ runId })}::jsonb, ${oldTs}, ${oldTs}),
      (${sessionId}, 'gcal_create_event', '2026-06-24T14:00:00+09:00', ${`${runId} executed no final`}, 'executed', ${`${runId}-executed-no-final`}, ${JSON.stringify({ runId })}::jsonb, ${oldTs}, ${oldTs}),
      (${sessionId}, 'gcal_create_event', '2026-06-24T15:00:00+09:00', ${`${runId} cancelled create`}, 'cancelled', ${`${runId}-cancelled-create`}, ${JSON.stringify({ runId })}::jsonb, ${oldTs}, ${oldTs})
  `;

  await sql`
    INSERT INTO tasks
      (session_id, initiated_by, agent_name, task_type, status, input, output, created_at, started_at, completed_at)
    VALUES
      (
        ${sessionId},
        'yui',
        'schedule',
        'specialist',
        'running',
        ${JSON.stringify({ runId, fixture: "stale_running_task" })}::jsonb,
        NULL,
        ${oldTs},
        ${oldTs},
        NULL
      ),
      (
        ${sessionId},
        'yui',
        'schedule',
        'specialist',
        'succeeded',
        ${JSON.stringify({ runId, fixture: "historical_final_without_executed" })}::jsonb,
        ${JSON.stringify({
          state: "completed",
          confirmFinal: {
            token: `${runId}-historical-final-no-executed`,
            toolName: "gcal_create_event",
            success: true,
            state: "completed",
            result: { event: { id: `${runId}-historical-event` } },
          },
        })}::jsonb,
        ${historicalTs},
        ${historicalTs},
        ${historicalTs}
      ),
      (
        ${sessionId},
        'yui',
        'schedule',
        'specialist',
        'succeeded',
        ${JSON.stringify({ runId, fixture: "cancelled_create_is_ok" })}::jsonb,
        ${JSON.stringify({
          state: "completed",
          confirmFinal: {
            token: `${runId}-cancelled-create`,
            toolName: "gcal_create_event",
            success: true,
            state: "completed",
            result: { event: { id: `${runId}-cancelled-event` } },
          },
        })}::jsonb,
        ${oldTs},
        ${oldTs},
        ${oldTs}
      ),
      (
        ${sessionId},
        'yui',
        'schedule',
        'specialist',
        'succeeded',
        ${JSON.stringify({ runId, fixture: "final_without_executed" })}::jsonb,
        ${JSON.stringify({
          state: "completed",
          confirmFinal: {
            token: `${runId}-final-no-executed`,
            toolName: "gcal_create_event",
            success: true,
            state: "completed",
            result: { event: { id: `${runId}-event` } },
          },
        })}::jsonb,
        ${oldTs},
        ${oldTs},
        ${oldTs}
      )
  `;
}

async function cleanup() {
  await sql`DELETE FROM tasks WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM tool_execution_log WHERE scope_key = ${sessionId}`;
}

async function main() {
  try {
    await cleanup();
    await seedFixtures();

    const issues = await collectReconciliationIssues(evalOptions);

    assert.equal(countKind(issues, "stale_pending_confirmation"), 2);
    assert.equal(countKind(issues, "orphan_pending_confirmation"), 1);
    assert.equal(countKind(issues, "stale_executing_reservation"), 1);
    assert.equal(countKind(issues, "stale_running_task"), 1);
    assert.equal(countKind(issues, "executed_reservation_without_confirm_final"), 1);
    assert.equal(countKind(issues, "confirm_final_without_executed_reservation"), 1);
    assert.equal(issues.length, 7);
    assert.equal(hasError(issues), true);

    const fixResult = await applySafeReconciliationFixes(issues);
    assert.equal(fixResult.fixedPendingConfirmations, 2);
    assert.equal(fixResult.fixedRunningTasks, 1);
    assert.equal(fixResult.skipped, 3);

    const afterFix = await collectReconciliationIssues(evalOptions);
    assert.equal(countKind(afterFix, "stale_pending_confirmation"), 0);
    assert.equal(countKind(afterFix, "orphan_pending_confirmation"), 0);
    assert.equal(countKind(afterFix, "stale_running_task"), 0);
    assert.equal(countKind(afterFix, "stale_executing_reservation"), 1);
    assert.equal(countKind(afterFix, "executed_reservation_without_confirm_final"), 1);
    assert.equal(countKind(afterFix, "confirm_final_without_executed_reservation"), 1);
    assert.equal(afterFix.length, 3);
    assert.equal(hasError(afterFix), true);

    console.log("Tool reconciliation eval");
    for (const issue of issues) {
      console.log(`ok - ${issue.kind} id=${issue.id}`);
    }
    console.log(
      `ok - safe fix pending=${fixResult.fixedPendingConfirmations} running=${fixResult.fixedRunningTasks} skipped=${fixResult.skipped}`,
    );
    console.log(`ok - after safe fix remaining=${afterFix.length}`);
    console.log(`\n${issues.length}/7 reconciliation fixtures detected`);
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
  });
