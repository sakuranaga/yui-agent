import assert from "node:assert/strict";
import { sql } from "@/db/client";
import { cacheDel, cacheSet } from "@/lib/cache";
import {
  applyConfirmDecision,
  executePendingTool,
  listPendingForSession,
  requestUserConfirm,
} from "@/lib/tools/confirm";
import { ALL_TOOLS } from "@/lib/tools/registry";
import type { ToolDef } from "@/lib/tools/types";

type ConfirmFinalRow = {
  status: string;
  confirm_final: {
    token?: string;
    toolName?: string;
    success?: boolean;
    state?: string;
    reason?: string | null;
    result?: unknown;
  } | null;
};

type LogRow = {
  status: string;
  confirm_token: string | null;
};

const RUN_ID = `confirm-phaseb-eval-${Date.now()}`;
const FINAL_VOICE_TTL_SEC = 24 * 60 * 60;

function findTool(name: string): ToolDef {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

function asMutableTool(tool: ToolDef): ToolDef {
  return tool;
}

async function insertTaskShell(sessionId: string, token: string): Promise<number> {
  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO tasks
      (session_id, initiated_by, agent_name, task_type, status, input, output)
    VALUES
      (
        ${sessionId},
        'yui',
        'confirm_phaseb_eval',
        'confirm_eval',
        'running',
        ${JSON.stringify({ runId: RUN_ID })}::jsonb,
        ${JSON.stringify({ state: "pending_confirmation", outcomes: [{ confirmToken: token }] })}::jsonb
      )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function insertReservation(sessionId: string, toolName: string, token: string): Promise<number> {
  const rows = await sql<Array<{ id: number }>>`
    INSERT INTO tool_execution_log
      (scope_key, tool_name, dedup_anchor, title_text, status, confirm_token, args)
    VALUES
      (
        ${sessionId},
        ${toolName},
        ${RUN_ID},
        ${`${RUN_ID} ${toolName}`},
        'pending_confirmation',
        ${token},
        ${JSON.stringify({ runId: RUN_ID })}::jsonb
      )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function loadConfirmFinal(taskId: number): Promise<ConfirmFinalRow> {
  const rows = await sql<ConfirmFinalRow[]>`
    SELECT status, output->'confirmFinal' AS confirm_final
    FROM tasks
    WHERE id = ${taskId}
  `;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

async function loadReservation(id: number): Promise<LogRow> {
  const rows = await sql<LogRow[]>`
    SELECT status, confirm_token
    FROM tool_execution_log
    WHERE id = ${id}
  `;
  assert.equal(rows.length, 1);
  return rows[0]!;
}

async function suppressFinalVoice(token: string): Promise<void> {
  await cacheSet(`tool-confirm:final-voice:${token}`, { emittedAt: Date.now(), runId: RUN_ID }, FINAL_VOICE_TTL_SEC);
}

async function cleanup(sessionId: string, token?: string): Promise<void> {
  const tokens = token ? [token] : [];
  try {
    tokens.push(...(await listPendingForSession(sessionId)));
  } catch {
    // ignore cleanup failures
  }
  await cacheDel(
    `tool-confirm:idx:${sessionId}`,
    ...tokens.flatMap((t) => [`tool-confirm:${t}`, `tool-confirm:final-voice:${t}`]),
  );
  await sql`DELETE FROM tasks WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM tool_execution_log WHERE args->>'runId' = ${RUN_ID}`;
}

async function withMockedTool<T>(
  toolName: string,
  mock: Pick<ToolDef, "handler"> & Partial<Pick<ToolDef, "isAvailable">>,
  fn: () => Promise<T>,
): Promise<T> {
  const tool = asMutableTool(findTool(toolName));
  const originalHandler = tool.handler;
  const originalIsAvailable = tool.isAvailable;
  tool.handler = mock.handler;
  tool.isAvailable = mock.isAvailable;
  try {
    return await fn();
  } finally {
    tool.handler = originalHandler;
    tool.isAvailable = originalIsAvailable;
  }
}

async function runApprovedFixture(): Promise<void> {
  const sessionId = `${RUN_ID}-approved`;
  let token: string | undefined;
  let calls = 0;
  await cleanup(sessionId);
  try {
    await withMockedTool(
      "gcal_create_event",
      {
        isAvailable: async () => true,
        handler: async (input) => {
          calls++;
          return {
            ok: true,
            event: {
              id: `${RUN_ID}-event`,
              calendar_id: "primary",
              summary: "PhaseBテスト",
              start: (input as { start?: unknown }).start,
              end: (input as { end?: unknown }).end,
              start_jst: "2026-06-24 20:00 JST",
              end_jst: "2026-06-24 21:00 JST",
            },
          };
        },
      },
      async () => {
        const pending = await requestUserConfirm({
          sessionId,
          toolName: "gcal_create_event",
          summary: "予定「PhaseBテスト」を登録します",
          inputSnapshot: {
            summary: "PhaseBテスト",
            start: { dateTime: "2026-06-24T20:00:00+09:00", timeZone: "Asia/Tokyo" },
            end: { dateTime: "2026-06-24T21:00:00+09:00", timeZone: "Asia/Tokyo" },
          },
          caller: { kind: "specialist", id: "schedule" },
          mode: "normal",
          confirmationPolicy: "confirm_external_send",
        });
        assert.ok(!("error" in pending));
        token = pending.token;
        await suppressFinalVoice(token);
        const taskId = await insertTaskShell(sessionId, token);
        const reservationId = await insertReservation(sessionId, "gcal_create_event", token);

        const decision = await applyConfirmDecision(token, "confirmed");
        assert.equal(decision.status, "confirmed");
        await executePendingTool(token);

        assert.equal(calls, 1);
        assert.deepEqual(await listPendingForSession(sessionId), []);
        const reservation = await loadReservation(reservationId);
        assert.equal(reservation.status, "executed");
        assert.equal(reservation.confirm_token, token);
        const task = await loadConfirmFinal(taskId);
        assert.equal(task.confirm_final?.token, token);
        assert.equal(task.confirm_final?.toolName, "gcal_create_event");
        assert.equal(task.confirm_final?.success, true);
        assert.equal(task.confirm_final?.state, "completed");
        assert.ok(task.confirm_final?.result);
      },
    );
  } finally {
    await cleanup(sessionId, token);
  }
}

async function runDeniedFixture(): Promise<void> {
  const sessionId = `${RUN_ID}-denied`;
  let token: string | undefined;
  let calls = 0;
  await cleanup(sessionId);
  try {
    await withMockedTool(
      "gcal_delete_event",
      {
        isAvailable: async () => true,
        handler: async () => {
          calls++;
          return { ok: true };
        },
      },
      async () => {
        const pending = await requestUserConfirm({
          sessionId,
          toolName: "gcal_delete_event",
          summary: "予定「PhaseBテスト」を削除します",
          inputSnapshot: { event_id: `${RUN_ID}-event`, calendar_id: "primary" },
          caller: { kind: "specialist", id: "schedule" },
          mode: "normal",
          confirmationPolicy: "confirm_destructive",
        });
        assert.ok(!("error" in pending));
        token = pending.token;
        await suppressFinalVoice(token);
        const taskId = await insertTaskShell(sessionId, token);
        const reservationId = await insertReservation(sessionId, "gcal_delete_event", token);

        const decision = await applyConfirmDecision(token, "denied");
        assert.equal(decision.status, "denied");
        await executePendingTool(token);

        assert.equal(calls, 0);
        assert.deepEqual(await listPendingForSession(sessionId), []);
        const reservation = await loadReservation(reservationId);
        assert.equal(reservation.status, "cancelled");
        assert.equal(reservation.confirm_token, token);
        const task = await loadConfirmFinal(taskId);
        assert.equal(task.confirm_final?.token, token);
        assert.equal(task.confirm_final?.toolName, "gcal_delete_event");
        assert.equal(task.confirm_final?.success, false);
        assert.equal(task.confirm_final?.state, "cancelled");
        assert.equal(task.confirm_final?.reason, "user denied");
      },
    );
  } finally {
    await cleanup(sessionId, token);
  }
}

async function main() {
  await runApprovedFixture();
  console.log("ok - confirmed pending executes handler once and finalizes state");
  await runDeniedFixture();
  console.log("ok - denied pending does not execute handler and cancels state");
  console.log("2/2 confirm phase B evals passed");
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
