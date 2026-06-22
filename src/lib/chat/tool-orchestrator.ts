import Anthropic from "@anthropic-ai/sdk";
import { resolveEntry } from "@/lib/llm";
import {
  runExecutor,
  type ExecutorComplete,
  type ExecutorRunResult,
  type ExtraToolHandler,
} from "@/lib/tools/executor";
import { retrieveToolCandidates, isActionIntent } from "@/lib/tools/tool-index";
import { decideToolGate, type ToolGateDecision } from "@/lib/tools/gate";
import type { DispatchLedger } from "@/lib/tools/dispatch";
import type { ToolContext, ToolDef } from "@/lib/tools/types";

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
};

export async function runToolOrchestrator(args: {
  currentUserMsg: string;
  recentHistory: Anthropic.MessageParam[];
  runtimeFacts: string;
  registryTools: ToolDef[];
  exposedSpecialistTools: Anthropic.Tool[];
  isUserTurn: boolean;
  mainCtx: ToolContext;
  dispatchLedger: DispatchLedger;
  onExtraTool: ExtraToolHandler;
  completeExecutor: ExecutorComplete;
}): Promise<ToolOrchestratorResult> {
  const debugLines: string[] = [];
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
    return { gateDecision, runExec, exec: null, debugLines };
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
      onExtraTool: args.onExtraTool,
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

  return { gateDecision, runExec, exec, debugLines };
}
