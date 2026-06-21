import {
  aggregateForReport,
  type ExecutorOutcome,
  type ExecutorStopReason,
} from "@/lib/tools/executor";
import type { UnifiedToolOutcome } from "@/lib/tools/outcome";

export type ExecutorResponsePlan = {
  actionMissed: boolean;
  needsC: boolean;
  reportText: string;
  finalDirectOutcomes: UnifiedToolOutcome[];
};

export function planExecutorResponse(args: {
  outcomes: ExecutorOutcome[];
  stopReason: ExecutorStopReason;
  isUserTurn: boolean;
  gateRequired: boolean;
  didMainFallback: boolean;
}): ExecutorResponsePlan {
  const actionMissed =
    args.isUserTurn &&
    args.gateRequired &&
    !args.didMainFallback &&
    args.outcomes.length === 0 &&
    args.stopReason !== "declined";

  const { text: reportText, needsC } = aggregateForReport(
    args.outcomes,
    args.stopReason,
    actionMissed,
  );

  const finalDirectOutcomes = args.outcomes
    .filter(
      (o) =>
        o.outcome.unifiedOutcome &&
        o.outcome.unifiedOutcome.userVisible === "final" &&
        (o.outcome.unifiedOutcome.responsePolicy === "final" ||
          o.outcome.unifiedOutcome.responsePolicy === "report") &&
        !o.toolName.startsWith("ask_"),
    )
    .map((o) => o.outcome.unifiedOutcome!)
    .filter((o) => o.state === "executed" || o.skipReason === "dedup_recent_execution");

  return {
    actionMissed,
    needsC,
    reportText,
    finalDirectOutcomes,
  };
}
