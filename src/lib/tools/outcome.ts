import type Anthropic from "@anthropic-ai/sdk";
import type {
  ConfirmationPolicy,
  ToolContext,
  ToolDef,
  ToolDisposition,
} from "./types";

export type ToolRunState =
  | "not_started"
  | "executing"
  | "pending_confirmation"
  | "executed"
  | "skipped"
  | "failed"
  | "cancelled";

export type ToolOutcomeSource =
  | "chat_turn"
  | "specialist_job"
  | "tool_confirm"
  | "dedup";

export type ToolResponsePolicy =
  | "none"
  | "ack"
  | "final"
  | "report"
  | "confirmation";

export type ToolUserVisible =
  | "none"
  | "ack"
  | "final"
  | "error"
  | "confirmation";

export type ToolSkipReason =
  | "dedup_recent_execution"
  | "budget"
  | "depth"
  | "duplicate";

export type UnifiedToolOutcome = {
  id: string;
  turnId?: string;
  jobId?: number;
  toolUseId?: string;
  confirmToken?: string;
  reservationId?: string;
  source: ToolOutcomeSource;
  toolName: string;
  kind: "direct" | "specialist" | "confirm_result";
  state: ToolRunState;
  disposition: ToolDisposition;
  responsePolicy: ToolResponsePolicy;
  userVisible: ToolUserVisible;
  input: unknown;
  result: unknown;
  error?: string;
  skipReason?: ToolSkipReason;
  confirmation?: {
    token: string;
    summary: string;
    policy: Exclude<ConfirmationPolicy, "auto">;
  };
  reportHints?: {
    title?: string;
    summary?: string;
    occurredAt?: string;
  };
};

export type OutcomeExecutionState =
  | "executed"
  | "pending_confirmation"
  | "skipped"
  | "failed";

export type OutcomeConversionInput = {
  tool: Pick<ToolDef, "name" | "surface" | "domain" | "confirmationPolicy">;
  toolUseId: string;
  input: unknown;
  executionState: OutcomeExecutionState;
  disposition: ToolDisposition;
  result: Anthropic.ToolResultBlockParam;
  skipReason?: ToolSkipReason;
  turnId?: string;
  jobId?: number;
  reservationId?: string;
  source?: ToolOutcomeSource;
  kind?: UnifiedToolOutcome["kind"];
};

export type ParsedToolResult = {
  value: unknown;
  error?: string;
  confirmRequired?: {
    token: string;
    summary: string;
    toolName?: string;
    inputSnapshot?: unknown;
  };
  duplicateSkipped?: boolean;
};

function parseJsonish(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function parseToolResultContent(
  result: Anthropic.ToolResultBlockParam,
): ParsedToolResult {
  const content = result.content;
  const value =
    typeof content === "string"
      ? parseJsonish(content)
      : Array.isArray(content)
        ? content.map((b) => (b.type === "text" ? b.text : b))
        : content;

  const obj =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  const confirmRequired =
    obj?.confirm_required === true && typeof obj.token === "string"
      ? {
          token: obj.token,
          summary: typeof obj.summary === "string" ? obj.summary : "",
          toolName: typeof obj.tool_name === "string" ? obj.tool_name : undefined,
          inputSnapshot: obj.input_snapshot,
        }
      : undefined;

  return {
    value,
    error:
      result.is_error && obj && typeof obj.error === "string"
        ? obj.error
        : result.is_error
          ? typeof value === "string"
            ? value
            : JSON.stringify(value)
          : undefined,
    confirmRequired,
    duplicateSkipped: obj?.duplicate_skipped === true,
  };
}

function defaultSource(ctx?: Pick<ToolContext, "caller">): ToolOutcomeSource {
  if (ctx?.caller.kind === "specialist") return "specialist_job";
  return "chat_turn";
}

function inferResponsePolicy(args: {
  executionState: OutcomeExecutionState;
  disposition: ToolDisposition;
  skipReason?: ToolSkipReason;
  tool: Pick<ToolDef, "surface" | "domain" | "confirmationPolicy">;
}): { responsePolicy: ToolResponsePolicy; userVisible: ToolUserVisible } {
  if (args.executionState === "pending_confirmation") {
    return { responsePolicy: "confirmation", userVisible: "confirmation" };
  }
  if (args.executionState === "failed") {
    return { responsePolicy: "report", userVisible: "error" };
  }
  if (args.executionState === "skipped") {
    if (args.skipReason === "dedup_recent_execution") {
      return { responsePolicy: "final", userVisible: "final" };
    }
    return { responsePolicy: "report", userVisible: "error" };
  }
  if (args.disposition === "report") {
    return { responsePolicy: "report", userVisible: "final" };
  }

  // Phase 1: metadata only. Existing behavior is unchanged, but mutation tools
  // that users explicitly asked for should become final-voice candidates in Phase 3.
  if (
    args.tool.surface === "mutate" &&
    (args.tool.domain === "schedule" ||
      args.tool.domain === "todo" ||
      args.tool.domain === "reminder" ||
      args.tool.domain === "timer" ||
      args.tool.domain === "project" ||
      args.tool.domain === "note")
  ) {
    return { responsePolicy: "final", userVisible: "final" };
  }
  if (args.tool.surface === "transport" && args.tool.domain === "music") {
    return { responsePolicy: "final", userVisible: "final" };
  }
  return { responsePolicy: "none", userVisible: "none" };
}

export function toUnifiedToolOutcome(
  args: OutcomeConversionInput,
): UnifiedToolOutcome {
  const parsed = parseToolResultContent(args.result);
  const policy = inferResponsePolicy(args);
  const confirmation =
    parsed.confirmRequired &&
    args.tool.confirmationPolicy &&
    args.tool.confirmationPolicy !== "auto"
      ? {
          token: parsed.confirmRequired.token,
          summary: parsed.confirmRequired.summary,
          policy: args.tool.confirmationPolicy,
        }
      : undefined;

  return {
    id: args.toolUseId,
    turnId: args.turnId,
    jobId: args.jobId,
    toolUseId: args.toolUseId,
    confirmToken: parsed.confirmRequired?.token,
    reservationId: args.reservationId,
    source: args.source ?? "chat_turn",
    toolName: args.tool.name,
    kind: args.kind ?? "direct",
    state: args.executionState,
    disposition: args.disposition,
    responsePolicy: policy.responsePolicy,
    userVisible: policy.userVisible,
    input: args.input,
    result: parsed.value,
    error: parsed.error,
    skipReason: args.skipReason,
    confirmation,
  };
}

export function toUnifiedToolOutcomeForContext(
  args: Omit<OutcomeConversionInput, "source"> & {
    ctx?: Pick<ToolContext, "caller">;
  },
): UnifiedToolOutcome {
  return toUnifiedToolOutcome({
    ...args,
    source: defaultSource(args.ctx),
    kind: args.kind ?? (args.ctx?.caller.kind === "specialist" ? "specialist" : "direct"),
  });
}

export function reduceToolRunState(
  outcomes: UnifiedToolOutcome[],
): "completed" | "pending_confirmation" | "failed" | "partial" | "skipped" {
  if (outcomes.some((o) => o.state === "pending_confirmation")) {
    return "pending_confirmation";
  }
  if (outcomes.length === 0) return "completed";
  const failed = outcomes.filter((o) => o.state === "failed");
  const skipped = outcomes.filter((o) => o.state === "skipped");
  const executed = outcomes.filter((o) => o.state === "executed");
  if (failed.length === outcomes.length) return "failed";
  if (executed.length === 0 && skipped.length === outcomes.length) return "skipped";
  if (failed.length > 0 || skipped.some((o) => o.skipReason !== "dedup_recent_execution")) {
    return "partial";
  }
  return "completed";
}
