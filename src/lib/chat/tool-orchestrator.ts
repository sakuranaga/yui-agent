import Anthropic from "@anthropic-ai/sdk";
import { desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { tasks } from "@/db/schema";
import { dispatchSpecialistJob } from "@/lib/jobs/dispatcher";
import { judgeDispatch } from "@/lib/judge/dispatch-judge";
import { resolveEntry } from "@/lib/llm";
import {
  runExecutor,
  type ExecutorComplete,
  type ExecutorRunResult,
} from "@/lib/tools/executor";
import { retrieveToolCandidates, isActionIntent } from "@/lib/tools/tool-index";
import { decideToolGate, type ToolGateDecision } from "@/lib/tools/gate";
import type { DispatchLedger, DispatchOutcome } from "@/lib/tools/dispatch";
import type { ToolContext, ToolDef } from "@/lib/tools/types";
import type { ClientMessage } from "@/lib/chat/context-builder";

type ConfirmedCalendarEventRef = {
  id: string;
  calendarId?: string;
  summary?: string;
  startJst?: string;
  endJst?: string;
  start?: unknown;
  end?: unknown;
};

function asPlainRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function stringValue(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function requestsScheduleDelete(text: string): boolean {
  return /(予定|スケジュール|カレンダー|アポ|予約).*(削除|消し|キャンセル|取消|取り消)|(?:削除|消し|キャンセル|取消|取り消).*(予定|スケジュール|カレンダー|アポ|予約)/u.test(text);
}

function refersToRecentTarget(text: string): boolean {
  return /(その|この|さっき|先ほど|直前|今(?:登録|追加|作成|入れ)た?|いま(?:登録|追加|作成|入れ)た?)/u.test(text);
}

function extractConfirmedCalendarEvent(output: unknown): ConfirmedCalendarEventRef | null {
  const root = asPlainRecord(output);
  const confirmFinal = asPlainRecord(root?.confirmFinal);
  if (!confirmFinal || confirmFinal.toolName !== "gcal_create_event" || confirmFinal.success !== true) {
    return null;
  }
  const result = asPlainRecord(confirmFinal.result);
  const event = asPlainRecord(result?.event);
  const id = stringValue(event?.id);
  if (!event || !id) return null;
  return {
    id,
    calendarId: stringValue(event.calendar_id) ?? stringValue(event.calendarId),
    summary: stringValue(event.summary),
    startJst: stringValue(event.start_jst),
    endJst: stringValue(event.end_jst),
    start: event.start,
    end: event.end,
  };
}

async function findLatestConfirmedCalendarCreate(
  sessionId: string
): Promise<ConfirmedCalendarEventRef | null> {
  const rows = await db
    .select({ output: tasks.output })
    .from(tasks)
    .where(eq(tasks.sessionId, sessionId))
    .orderBy(desc(tasks.createdAt), desc(tasks.id))
    .limit(20);
  for (const row of rows) {
    const event = extractConfirmedCalendarEvent(row.output);
    if (event) return event;
  }
  return null;
}

function buildExplicitDeleteQuery(event: ConfirmedCalendarEventRef, originalQuery: string): string {
  const parts = [
    "直近に登録完了した次の1件だけを削除して。",
    `event_id=${event.id}`,
    `calendar_id=${event.calendarId ?? "primary"}`,
  ];
  if (event.summary) parts.push(`summary="${event.summary}"`);
  if (event.startJst) parts.push(`start_jst="${event.startJst}"`);
  if (event.endJst) parts.push(`end_jst="${event.endJst}"`);
  parts.push("gcal_delete_event input には event_id に加えて、分かっている summary/start_jst/end_jst も必ず含める。");
  parts.push("他の候補を検索してまとめて削除しない。該当 event_id の1件だけを対象にする。");
  if (originalQuery) parts.push(`元の依頼: ${originalQuery}`);
  return parts.join(" ");
}

function shouldUseCurrentOnlyForExecutor(
  gateDecision: ToolGateDecision,
  currentUserMsg: string
): boolean {
  if (gateDecision.decision !== "tool_required") return false;
  if (gateDecision.category !== "mutate") return false;
  const hasMutationVerb =
    /(追加|登録|入れ|作成|作って|保存|更新|変更|消し|削除|送って|送信|リマインダー|TODO|予定)/.test(
      currentUserMsg
    );
  const hasTimeOrDate =
    /(今日|明日|明後日|来週|今週|[0-9０-９]{1,2}\s*時|午前|午後|朝|昼|夜|[0-9０-９]{1,2}\s*分後|[0-9０-９]{4}[-/年])/u.test(
      currentUserMsg
    );
  return hasMutationVerb && hasTimeOrDate;
}

export type ToolOrchestratorResult = {
  gateDecision: ToolGateDecision;
  runExec: boolean;
  exec: ExecutorRunResult | null;
  debugLines: string[];
  pendingJobs: Array<{ jobId: number; specialist: string }>;
};

export async function runToolOrchestrator(args: {
  sessionId: string;
  currentUserMsg: string;
  messages: ClientMessage[];
  recentHistory: Anthropic.MessageParam[];
  runtimeFacts: string;
  envBlock: string;
  registryTools: ToolDef[];
  exposedSpecialistTools: Anthropic.Tool[];
  isUserTurn: boolean;
  mainCtx: ToolContext;
  dispatchLedger: DispatchLedger;
  completeExecutor: ExecutorComplete;
}): Promise<ToolOrchestratorResult> {
  const debugLines: string[] = [];
  const pendingJobs: Array<{ jobId: number; specialist: string }> = [];
  const canRunExec = args.registryTools.length > 0 || args.exposedSpecialistTools.length > 0;
  let gateDecision: ToolGateDecision = {
    decision: "no_tool",
    category: "chat",
    waitPolicy: "wait",
    confidence: 1,
    reason: "gate skipped for non-user/internal turn",
  };

  if (canRunExec && args.isUserTurn) {
    gateDecision = await decideToolGate({
      currentUserMsg: args.currentUserMsg,
      recentHistory: args.recentHistory,
      runtimeFacts: args.runtimeFacts,
    });
  }

  const runExec = canRunExec && gateDecision.decision === "tool_required";
  debugLines.push(
    `- gate: ${gateDecision.decision} category=${gateDecision.category} wait=${gateDecision.waitPolicy} confidence=${gateDecision.confidence.toFixed(2)}${gateDecision.fallback ? ` fallback=${gateDecision.fallback}` : ""}`,
  );
  if (process.env.NODE_ENV !== "production") {
    console.log(
      `[tool-gate] ${gateDecision.decision} category=${gateDecision.category} wait=${gateDecision.waitPolicy} confidence=${gateDecision.confidence.toFixed(2)} reason="${gateDecision.reason.slice(0, 80)}"`,
    );
  }

  if (!runExec) {
    return { gateDecision, runExec, exec: null, debugLines, pendingJobs };
  }

  let executorTools = args.registryTools;
  if (args.registryTools.length > 0) {
    try {
      const retrieval = await retrieveToolCandidates({
        query: args.currentUserMsg,
        permitted: args.registryTools,
      });
      if (retrieval.mode !== "full-catalog") {
        const candidateSet = new Set(retrieval.toolNames);
        const filtered = args.registryTools.filter((t) => candidateSet.has(t.name));
        if (filtered.length > 0) executorTools = filtered;
      }
      debugLines.push(`- retrieval: ${retrieval.mode} ${args.registryTools.length}→${executorTools.length}`);
      if (process.env.NODE_ENV !== "production") {
        console.log(
          `[tool-retrieval] mode=${retrieval.mode} ${args.registryTools.length}→${executorTools.length} q="${args.currentUserMsg.slice(0, 30)}"`,
        );
      }
    } catch (e) {
      console.warn("[tool-retrieval] 失敗 → 全ツールで継続:", e);
    }
  }

  const execEntry = await resolveEntry("executor").catch(() => null);
  const singlePass = /xlam|functionary|gorilla/i.test(execEntry?.entry.modelId ?? "");
  const currentOnly = shouldUseCurrentOnlyForExecutor(gateDecision, args.currentUserMsg);
  const execHistory =
    singlePass || currentOnly
      ? [{ role: "user" as const, content: args.currentUserMsg }]
      : args.recentHistory;
  if (currentOnly) {
    debugLines.push("- executor history: self-contained mutation のため最新発話のみ");
  }

  const runOnce = (tools: ToolDef[]) =>
    runExecutor({
      recentHistory: execHistory,
      runtimeFacts: args.runtimeFacts,
      tools,
      singlePass,
      ctx: args.mainCtx,
      ledger: args.dispatchLedger,
      complete: args.completeExecutor,
      extraTools: args.exposedSpecialistTools,
      onExtraTool: async (tu) => {
        const input = (tu.input ?? {}) as { query?: string };
        let query = input.query ?? "";
        if (
          tu.name === "ask_schedule_specialist" &&
          requestsScheduleDelete(args.currentUserMsg) &&
          refersToRecentTarget(args.currentUserMsg)
        ) {
          const recentCreatedEvent = await findLatestConfirmedCalendarCreate(args.sessionId);
          if (recentCreatedEvent) {
            query = buildExplicitDeleteQuery(recentCreatedEvent, query);
            input.query = query;
            debugLines.push(
              `- schedule reference resolved: delete event_id=${recentCreatedEvent.id} title=${recentCreatedEvent.summary ?? "(no title)"}`,
            );
          } else {
            debugLines.push("- schedule reference unresolved: no recent confirmed calendar create");
          }
        }

        const judgeStart = Date.now();
        const decision = await judgeDispatch({
          userMessage: args.currentUserMsg,
          yuiAckText: "",
          toolName: tu.name,
          toolQuery: query,
          envBlock: args.envBlock,
        });
        if (process.env.NODE_ENV !== "production") {
          console.log(`[judge] ${tu.name} → ${decision.action} (${decision.reason}) [${Date.now() - judgeStart}ms]`);
        }
        if (decision.action === "skip") {
          return {
            executionState: "skipped",
            disposition: "report",
            result: {
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify({ skipped: true, reason: decision.reason }),
            },
          } satisfies DispatchOutcome;
        }

        const result = await dispatchSpecialistJob({
          sessionId: args.sessionId,
          yuiToolName: tu.name,
          query,
          originalUserMessage: args.currentUserMsg,
          conversationHistory: args.messages.map((m) => ({ role: m.role, content: m.content })),
          yuiAckText: "",
        });
        if (result.ok) {
          pendingJobs.push({ jobId: result.jobId, specialist: tu.name });
          if (process.env.NODE_ENV !== "production") {
            console.log(`[chat] dispatched job=${result.jobId} ${tu.name} query="${query.slice(0, 40)}"`);
          }
          return {
            executionState: "executed",
            disposition: "silent",
            result: {
              type: "tool_result",
              tool_use_id: tu.id,
              content: JSON.stringify({ dispatched: true, job_id: result.jobId }),
            },
          } satisfies DispatchOutcome;
        }

        console.warn(`[chat] failed to dispatch ${tu.name}: ${result.error}`);
        return {
          executionState: "failed",
          disposition: "report",
          result: {
            type: "tool_result",
            tool_use_id: tu.id,
            content: JSON.stringify({ error: `Specialist dispatch failed: ${result.error}` }),
            is_error: true,
          },
        } satisfies DispatchOutcome;
      },
    });

  let exec = await runOnce(executorTools);
  const narrowed = executorTools.length < args.registryTools.length;
  if (
    narrowed &&
    exec.outcomes.length === 0 &&
    exec.stopReason !== "declined" &&
    isActionIntent(args.currentUserMsg)
  ) {
    if (process.env.NODE_ENV !== "production") {
      console.log("[tool-retrieval] no_tool_calls + action-intent → full catalog 再試行");
    }
    exec = await runOnce(args.registryTools);
  }

  return { gateDecision, runExec, exec, debugLines, pendingJobs };
}
