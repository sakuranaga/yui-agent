import { pathToFileURL } from "node:url";
import { sql } from "@/db/client";

export type ReconciliationSeverity = "error" | "warn";

export type ReconciliationIssue = {
  kind:
    | "stale_pending_confirmation"
    | "orphan_pending_confirmation"
    | "stale_executing_reservation"
    | "stale_running_task"
    | "executed_reservation_without_confirm_final"
    | "confirm_final_without_executed_reservation";
  severity: ReconciliationSeverity;
  id: number;
  sessionId?: string | null;
  toolName?: string | null;
  confirmToken?: string | null;
  ageMinutes: number;
  action: string;
};

export type ReconciliationOptions = {
  pendingMinutes?: number;
  orphanPendingMinutes?: number;
  executingMinutes?: number;
  runningTaskMinutes?: number;
  confirmFinalGraceMinutes?: number;
  sessionIdPrefix?: string;
};

export type ReconciliationFixResult = {
  fixedPendingConfirmations: number;
  fixedRunningTasks: number;
  skipped: number;
};

type RawIssueRow = {
  kind: ReconciliationIssue["kind"];
  severity: ReconciliationSeverity;
  id: number | string | bigint;
  session_id: string | null;
  tool_name: string | null;
  confirm_token: string | null;
  age_minutes: number | string;
  action: string;
};

function toNumber(v: unknown): number {
  if (typeof v === "number") return v;
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "string") return Number(v);
  return 0;
}

function minutes(v: unknown): number {
  return Math.round(toNumber(v) * 10) / 10;
}

function mapRow(row: RawIssueRow): ReconciliationIssue {
  return {
    kind: row.kind,
    severity: row.severity,
    id: toNumber(row.id),
    sessionId: row.session_id,
    toolName: row.tool_name,
    confirmToken: row.confirm_token,
    ageMinutes: minutes(row.age_minutes),
    action: row.action,
  };
}

function scopedSql(sessionIdPrefix?: string) {
  if (!sessionIdPrefix) return sql``;
  return sql`AND COALESCE(t.session_id, l.scope_key, '') LIKE ${`${sessionIdPrefix}%`}`;
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values.filter((v) => Number.isInteger(v) && v > 0))];
}

export async function collectReconciliationIssues(
  options: ReconciliationOptions = {},
): Promise<ReconciliationIssue[]> {
  const pendingMinutes = options.pendingMinutes ?? Number(process.env.TOOL_RECONCILE_PENDING_MINUTES ?? 60);
  const orphanPendingMinutes =
    options.orphanPendingMinutes ?? Number(process.env.TOOL_RECONCILE_ORPHAN_PENDING_MINUTES ?? 5);
  const executingMinutes = options.executingMinutes ?? Number(process.env.TOOL_RECONCILE_EXECUTING_MINUTES ?? 60);
  const runningTaskMinutes =
    options.runningTaskMinutes ?? Number(process.env.TOOL_RECONCILE_RUNNING_TASK_MINUTES ?? 30);
  const confirmFinalGraceMinutes =
    options.confirmFinalGraceMinutes ?? Number(process.env.TOOL_RECONCILE_CONFIRM_FINAL_GRACE_MINUTES ?? 2);
  const sessionIdPrefix = options.sessionIdPrefix ?? process.env.TOOL_RECONCILE_SESSION_PREFIX;

  const stalePending = await sql<RawIssueRow[]>`
    SELECT
      'stale_pending_confirmation'::text AS kind,
      'error'::text AS severity,
      l.id,
      NULL::text AS session_id,
      l.tool_name,
      l.confirm_token,
      EXTRACT(EPOCH FROM (now() - l.updated_at)) / 60 AS age_minutes,
      'cancel after confirmation TTL; user can retry'::text AS action
    FROM tool_execution_log l
    LEFT JOIN tasks t ON t.output->'confirmFinal'->>'token' = l.confirm_token
    WHERE l.status = 'pending_confirmation'
      AND l.updated_at < now() - (${pendingMinutes} || ' minutes')::interval
      ${scopedSql(sessionIdPrefix)}
    ORDER BY l.updated_at ASC
    LIMIT 50
  `;

  const orphanPending = await sql<RawIssueRow[]>`
    SELECT
      'orphan_pending_confirmation'::text AS kind,
      'error'::text AS severity,
      l.id,
      NULL::text AS session_id,
      l.tool_name,
      l.confirm_token,
      EXTRACT(EPOCH FROM (now() - l.updated_at)) / 60 AS age_minutes,
      'reservation has no confirm token; cancel after grace period'::text AS action
    FROM tool_execution_log l
    LEFT JOIN tasks t ON false
    WHERE l.status = 'pending_confirmation'
      AND l.confirm_token IS NULL
      AND l.updated_at < now() - (${orphanPendingMinutes} || ' minutes')::interval
      ${scopedSql(sessionIdPrefix)}
    ORDER BY l.updated_at ASC
    LIMIT 50
  `;

  const staleExecuting = await sql<RawIssueRow[]>`
    SELECT
      'stale_executing_reservation'::text AS kind,
      'warn'::text AS severity,
      l.id,
      NULL::text AS session_id,
      l.tool_name,
      l.confirm_token,
      EXTRACT(EPOCH FROM (now() - l.updated_at)) / 60 AS age_minutes,
      'inspect external side effect; do not replay automatically'::text AS action
    FROM tool_execution_log l
    LEFT JOIN tasks t ON false
    WHERE l.status = 'executing'
      AND l.updated_at < now() - (${executingMinutes} || ' minutes')::interval
      ${scopedSql(sessionIdPrefix)}
    ORDER BY l.updated_at ASC
    LIMIT 50
  `;

  const staleRunningTasks = await sql<RawIssueRow[]>`
    SELECT
      'stale_running_task'::text AS kind,
      'error'::text AS severity,
      t.id,
      t.session_id,
      t.agent_name AS tool_name,
      NULL::text AS confirm_token,
      EXTRACT(EPOCH FROM (now() - COALESCE(t.started_at, t.created_at))) / 60 AS age_minutes,
      'mark failed/cancelled only after checking whether background work is alive'::text AS action
    FROM tasks t
    LEFT JOIN tool_execution_log l ON false
    WHERE t.status = 'running'
      AND COALESCE(t.started_at, t.created_at) < now() - (${runningTaskMinutes} || ' minutes')::interval
      ${scopedSql(sessionIdPrefix)}
    ORDER BY COALESCE(t.started_at, t.created_at) ASC
    LIMIT 50
  `;

  const executedWithoutFinal = await sql<RawIssueRow[]>`
    SELECT
      'executed_reservation_without_confirm_final'::text AS kind,
      'error'::text AS severity,
      l.id,
      NULL::text AS session_id,
      l.tool_name,
      l.confirm_token,
      EXTRACT(EPOCH FROM (now() - l.updated_at)) / 60 AS age_minutes,
      'confirm handler may have finalized reservation before task final; inspect and backfill manually'::text AS action
    FROM tool_execution_log l
    LEFT JOIN tasks t ON t.output->'confirmFinal'->>'token' = l.confirm_token
    WHERE l.status = 'executed'
      AND l.confirm_token IS NOT NULL
      AND l.updated_at < now() - (${confirmFinalGraceMinutes} || ' minutes')::interval
      AND t.id IS NULL
      ${scopedSql(sessionIdPrefix)}
    ORDER BY l.updated_at ASC
    LIMIT 50
  `;

  const finalWithoutExecuted = await sql<RawIssueRow[]>`
    SELECT
      'confirm_final_without_executed_reservation'::text AS kind,
      'warn'::text AS severity,
      t.id,
      t.session_id,
      t.output->'confirmFinal'->>'toolName' AS tool_name,
      t.output->'confirmFinal'->>'token' AS confirm_token,
      EXTRACT(EPOCH FROM (now() - COALESCE(t.completed_at, t.created_at))) / 60 AS age_minutes,
      'confirm final exists but executed reservation is missing; inspect dedup log'::text AS action
    FROM tasks t
    LEFT JOIN tool_execution_log l
      ON l.confirm_token = t.output->'confirmFinal'->>'token'
     AND l.status = 'executed'
    WHERE t.output ? 'confirmFinal'
      AND t.output->'confirmFinal'->>'success' = 'true'
      AND t.output->'confirmFinal'->>'token' IS NOT NULL
      AND COALESCE(t.completed_at, t.created_at) < now() - (${confirmFinalGraceMinutes} || ' minutes')::interval
      AND l.id IS NULL
      ${scopedSql(sessionIdPrefix)}
    ORDER BY COALESCE(t.completed_at, t.created_at) ASC
    LIMIT 50
  `;

  return [
    ...stalePending,
    ...orphanPending,
    ...staleExecuting,
    ...staleRunningTasks,
    ...executedWithoutFinal,
    ...finalWithoutExecuted,
  ]
    .map(mapRow)
    .sort((a, b) => {
      const sev = a.severity.localeCompare(b.severity);
      if (sev !== 0) return sev;
      return b.ageMinutes - a.ageMinutes;
    });
}

export async function applySafeReconciliationFixes(
  issues: ReconciliationIssue[],
): Promise<ReconciliationFixResult> {
  const pendingIds = uniqueNumbers(
    issues
      .filter(
        (issue) =>
          issue.kind === "stale_pending_confirmation" ||
          issue.kind === "orphan_pending_confirmation",
      )
      .map((issue) => issue.id),
  );
  const runningTaskIds = uniqueNumbers(
    issues.filter((issue) => issue.kind === "stale_running_task").map((issue) => issue.id),
  );
  const skipped = issues.filter(
    (issue) =>
      issue.kind !== "stale_pending_confirmation" &&
      issue.kind !== "orphan_pending_confirmation" &&
      issue.kind !== "stale_running_task",
  ).length;

  let fixedPendingConfirmations = 0;
  let fixedRunningTasks = 0;

  if (pendingIds.length > 0) {
    const rows = await sql<Array<{ id: number }>>`
      UPDATE tool_execution_log
      SET status = 'cancelled', updated_at = now()
      WHERE id = ANY(${pendingIds}::bigint[])
        AND status = 'pending_confirmation'
      RETURNING id
    `;
    fixedPendingConfirmations = rows.length;
  }

  if (runningTaskIds.length > 0) {
    const rows = await sql<Array<{ id: number }>>`
      UPDATE tasks
      SET
        status = 'failed',
        completed_at = now(),
        error = COALESCE(error, 'reconciliation: stale running task marked failed')
      WHERE id = ANY(${runningTaskIds}::bigint[])
        AND status = 'running'
      RETURNING id
    `;
    fixedRunningTasks = rows.length;
  }

  return { fixedPendingConfirmations, fixedRunningTasks, skipped };
}

function printIssues(issues: ReconciliationIssue[], fixResult?: ReconciliationFixResult) {
  console.log("Tool reconciliation dry-run");
  if (issues.length === 0) {
    console.log("[ok] no reconciliation candidates");
    return;
  }
  const hasError = issues.some((issue) => issue.severity === "error");
  console.log(`[${hasError ? "ng" : "warn"}] reconciliation candidates: ${issues.length}`);
  for (const issue of issues) {
    const parts = [
      issue.kind,
      `severity=${issue.severity}`,
      `id=${issue.id}`,
      issue.toolName ? `tool=${issue.toolName}` : "",
      issue.sessionId ? `session=${issue.sessionId}` : "",
      issue.confirmToken ? `token=${issue.confirmToken}` : "",
      `age=${issue.ageMinutes}m`,
      `action=${issue.action}`,
    ].filter(Boolean);
    console.log(`- ${parts.join(" ")}`);
  }
  if (fixResult) {
    console.log("fix result:");
    console.log(`- pending confirmations cancelled: ${fixResult.fixedPendingConfirmations}`);
    console.log(`- running tasks marked failed: ${fixResult.fixedRunningTasks}`);
    console.log(`- skipped unsafe/manual issues: ${fixResult.skipped}`);
  }
}

async function main() {
  const json = process.argv.includes("--json");
  const strict = process.argv.includes("--strict");
  const fix = process.argv.includes("--fix");
  const issues = await collectReconciliationIssues();
  const fixResult = fix ? await applySafeReconciliationFixes(issues) : undefined;
  const remainingIssues = fix ? await collectReconciliationIssues() : issues;
  const hasError = remainingIssues.some((issue) => issue.severity === "error");
  const shouldFail = strict ? remainingIssues.length > 0 : hasError;
  if (json) {
    console.log(
      JSON.stringify(
        { ok: !shouldFail, issues: remainingIssues, fixedFromInitialIssues: fixResult },
        null,
        2,
      ),
    );
  } else {
    printIssues(fix ? remainingIssues : issues, fixResult);
  }
  process.exitCode = shouldFail ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .catch((e) => {
      console.error(e);
      process.exitCode = 1;
    })
    .finally(async () => {
      await sql.end({ timeout: 1 });
    });
}
