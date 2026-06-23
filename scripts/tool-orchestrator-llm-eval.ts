import type Anthropic from "@anthropic-ai/sdk";
import { sql } from "@/db/client";
import { callLlm } from "@/lib/llm";
import { cacheDel } from "@/lib/cache";
import { buildToolContextBundle, type ClientMessage } from "@/lib/chat/context-builder";
import { planExecutorResponse } from "@/lib/chat/response-planner";
import { runToolOrchestrator, type ToolOrchestratorResult } from "@/lib/chat/tool-orchestrator";
import { createDispatchLedger } from "@/lib/tools/dispatch";
import { listPendingForSession } from "@/lib/tools/confirm";
import { gcalCreateEvent } from "@/lib/tools/schedule/gcal_create_event";
import { gcalDeleteEvent } from "@/lib/tools/schedule/gcal_delete_event";
import { gcalListEvents } from "@/lib/tools/schedule/gcal_list_events";
import { addReminderTool } from "@/lib/tools/reminder/add_reminder";
import { addTodoTool } from "@/lib/tools/todo/add_todo";
import { saveNote } from "@/lib/tools/note/save_note";
import { gmailSearch } from "@/lib/tools/mail/gmail_search";
import { musicNowPlaying } from "@/lib/tools/music/music_now_playing";
import { searchContactsTool } from "@/lib/tools/contact/search_contacts";
import { webSearch } from "@/lib/tools/web/web_search";
import type { ToolContext, ToolDef } from "@/lib/tools/types";

type Fixture = {
  name: string;
  messages: ClientMessage[];
  expectedGate: "no_tool" | "tool_required";
  expectedTool?: string | null;
  expectedStop?: string;
  expectedState?: string;
  forbiddenTools?: string[];
  validate?: (result: ToolOrchestratorResult) => string[];
};

const MIN_PASS = Number(process.env.TOOL_ORCHESTRATOR_LLM_EVAL_MIN_PASS ?? 8);
const BASE_NOW = new Date("2026-06-23T12:00:00+09:00");

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function contains(input: unknown, pattern: RegExp): boolean {
  return pattern.test(stringify(input));
}

function cloneForEval(tool: ToolDef, opts: { keepConfirm?: boolean } = {}): ToolDef {
  return {
    ...tool,
    callableBy: [{ kind: "main" }],
    confirmationPolicy: opts.keepConfirm ? tool.confirmationPolicy : "auto",
    isAvailable: undefined,
    availabilityKey: undefined,
    dedup: undefined,
    handler: async (input) => ({ ok: true, input }),
  };
}

const registryTools = [
  cloneForEval(gcalCreateEvent, { keepConfirm: true }),
  cloneForEval(gcalDeleteEvent, { keepConfirm: true }),
  cloneForEval(gcalListEvents),
  cloneForEval(addReminderTool),
  cloneForEval(addTodoTool),
  cloneForEval(saveNote),
  cloneForEval(gmailSearch),
  cloneForEval(musicNowPlaying),
  cloneForEval(searchContactsTool),
  cloneForEval(webSearch),
];

const runtimeContext = [
  "現在日時: 2026-06-23 12:00 JST",
  "タイムゾーン: Asia/Tokyo",
  "相対日付: 今日=2026-06-23, 明日=2026-06-24, 明後日=2026-06-25",
  "ユーザーの現在地: 軽井沢",
].join("\n");

const fixtures: Fixture[] = [
  {
    name: "small talk stays out of tools",
    messages: [{ role: "user", content: "ありがとう" }],
    expectedGate: "no_tool",
    expectedTool: null,
  },
  {
    name: "calendar read goes through read tool",
    messages: [{ role: "user", content: "明日の予定を教えて" }],
    expectedGate: "tool_required",
    expectedTool: "gcal_list_events",
    expectedState: "executed",
    validate: (result) => {
      const input = result.exec?.outcomes[0]?.input;
      const errors: string[] = [];
      if (!contains(input, /2026-06-24/)) errors.push("calendar read should target tomorrow");
      return errors;
    },
  },
  {
    name: "calendar create becomes pending confirmation",
    messages: [{ role: "user", content: "明日20時にテスト予定を入れて" }],
    expectedGate: "tool_required",
    expectedTool: "gcal_create_event",
    expectedStop: "pending_confirmation",
    expectedState: "pending_confirmation",
    validate: (result) => {
      const plan = result.exec
        ? planExecutorResponse({
            outcomes: result.exec.outcomes,
            stopReason: result.exec.stopReason,
            isUserTurn: true,
            gateRequired: true,
            didMainFallback: false,
          })
        : null;
      const errors: string[] = [];
      if (plan?.finalDirectOutcomes.length) errors.push("pending confirmation must not be a final direct outcome");
      if (!plan?.needsC) errors.push("pending confirmation should be reportable");
      if (!/確認待ち/.test(plan?.reportText ?? "")) errors.push("pending report should mention confirmation wait");
      return errors;
    },
  },
  {
    name: "delete without event id searches instead of direct delete",
    messages: [{ role: "user", content: "テスト予定を削除して" }],
    expectedGate: "tool_required",
    expectedTool: "gcal_list_events",
    expectedState: "executed",
    forbiddenTools: ["gcal_delete_event"],
    validate: (result) => {
      const input = result.exec?.outcomes[0]?.input;
      return contains(input, /テスト/) ? [] : ["delete lookup should search by テスト"];
    },
  },
  {
    name: "explicit event id delete becomes pending confirmation",
    messages: [{ role: "user", content: "予定 event_id abc123 を削除して" }],
    expectedGate: "tool_required",
    expectedTool: "gcal_delete_event",
    expectedStop: "pending_confirmation",
    expectedState: "pending_confirmation",
    validate: (result) => {
      const input = asRecord(result.exec?.outcomes[0]?.input);
      return input.event_id === "abc123" ? [] : ["delete input should keep event_id abc123"];
    },
  },
  {
    name: "ambiguous calendar create is declined",
    messages: [{ role: "user", content: "予定入れといて" }],
    expectedGate: "tool_required",
    expectedTool: null,
    validate: (result) => {
      const stop = result.exec?.stopReason;
      return stop === "declined" || stop === "no_tool_calls" ? [] : [`ambiguous create should decline, got ${stop}`];
    },
  },
  {
    name: "history reference create keeps user context",
    messages: [
      { role: "user", content: "明日は晴れるかな？晴れたらゴルフに行きたいと思ってる" },
      { role: "assistant", content: "明日の軽井沢は晴れそうです。" },
      { role: "user", content: "じゃあ、予定入れといて" },
      { role: "assistant", content: "開始時刻を教えていただけますか？" },
      { role: "user", content: "9時から。中軽井沢ゴルフクラブで" },
    ],
    expectedGate: "tool_required",
    expectedTool: "gcal_create_event",
    expectedStop: "pending_confirmation",
    expectedState: "pending_confirmation",
    validate: (result) => {
      const input = result.exec?.outcomes[0]?.input;
      const errors: string[] = [];
      if (!contains(input, /ゴルフ/)) errors.push("history reference should infer golf");
      if (!contains(input, /中軽井沢ゴルフクラブ/)) errors.push("history reference should keep location");
      if (!contains(input, /2026-06-24.*09|2026-06-24.*9/)) errors.push("history reference should target tomorrow 9:00");
      return errors;
    },
  },
  {
    name: "reminder create executes auto path",
    messages: [{ role: "user", content: "今日15時にコーラを買うリマインダーを追加して" }],
    expectedGate: "tool_required",
    expectedTool: "add_reminder",
    expectedState: "executed",
  },
  {
    name: "todo create executes auto path",
    messages: [{ role: "user", content: "ほしい物リストに3Dプリンターを入れて" }],
    expectedGate: "tool_required",
    expectedTool: "add_todo",
    expectedState: "executed",
  },
  {
    name: "mail read routes to gmail search",
    messages: [{ role: "user", content: "Gmailで未読メールを探して" }],
    expectedGate: "tool_required",
    expectedTool: "gmail_search",
    expectedState: "executed",
  },
  {
    name: "music status routes to now playing",
    messages: [{ role: "user", content: "今流れてる曲は？" }],
    expectedGate: "tool_required",
    expectedTool: "music_now_playing",
    expectedState: "executed",
  },
  {
    name: "contact read routes to contact search",
    messages: [{ role: "user", content: "連絡先から田中さん探して" }],
    expectedGate: "tool_required",
    expectedTool: "search_contacts",
    expectedState: "executed",
  },
  {
    name: "external verification resolves assistant claim",
    messages: [
      {
        role: "assistant",
        content:
          "気になるニュースですが、ご主人様が気になっている「Palmier Pro」や「OCR 4」は、日本語に対応していますよ。",
      },
      { role: "user", content: "へえ、それはちゃんとWebで検索して確認した？" },
    ],
    expectedGate: "tool_required",
    expectedTool: "web_search",
    expectedState: "executed",
    validate: (result) => {
      const input = result.exec?.outcomes[0]?.input;
      const errors: string[] = [];
      if (!contains(input, /Palmier Pro|OCR 4|日本語対応/)) {
        errors.push("web_search query should include assistant claim terms");
      }
      if (!result.debugLines.some((l) => /reference_claims: 1/.test(l))) {
        errors.push("debug should expose reference_claims=1");
      }
      return errors;
    },
  },
];

const completeExecutor = async ({ system, messages, tools }: {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
}) =>
  callLlm("executor", {
    system,
    messages,
    tools,
    maxTokens: 1024,
    temperature: 0,
    retry: false,
  });

async function cleanupConfirmSession(sessionId: string): Promise<void> {
  const tokens = await listPendingForSession(sessionId);
  await cacheDel(`tool-confirm:idx:${sessionId}`, ...tokens.map((token) => `tool-confirm:${token}`));
}

async function runFixture(fixture: Fixture, index: number): Promise<boolean> {
  const sessionId = `tool-orchestrator-llm-eval-${Date.now()}-${index}`;
  const currentUserMsg = fixture.messages[fixture.messages.length - 1]?.content ?? "";
  const historyTimestamps = fixture.messages.map((_, i) => new Date(BASE_NOW.getTime() - (fixture.messages.length - i) * 60_000));
  const toolContext = buildToolContextBundle({
    messages: fixture.messages,
    currentUserMsg,
    historyTimestamps,
    toolMode: "normal",
    source: "eval",
    now: BASE_NOW,
  });
  const { executorHistory: recentHistory, runtimeFacts } = toolContext;
  const ctx: ToolContext = {
    sessionId,
    caller: { kind: "main" },
    mode: "normal",
    userUtterance: currentUserMsg,
    availabilityCache: new Map(),
  };

  try {
    const result = await runToolOrchestrator({
      sessionId,
      currentUserMsg,
      messages: fixture.messages,
      recentHistory,
      gateHistory: toolContext.gateHistory,
      retrievalQuery: toolContext.retrievalQuery,
      referenceClaims: toolContext.referenceClaims,
      runtimeFacts: `${runtimeContext}\n${runtimeFacts}`,
      envBlock: runtimeContext,
      registryTools,
      exposedSpecialistTools: [],
      isUserTurn: true,
      mainCtx: ctx,
      dispatchLedger: createDispatchLedger({ budget: 8 }),
      completeExecutor,
    });

    const outcomes = result.exec?.outcomes ?? [];
    const actualTool = outcomes[0]?.toolName ?? null;
    const actualState = outcomes[0]?.outcome.executionState ?? null;
    const errors = [
      ...(result.gateDecision.decision === fixture.expectedGate
        ? []
        : [`gate should be ${fixture.expectedGate}, got ${result.gateDecision.decision}`]),
      ...(fixture.forbiddenTools?.includes(actualTool ?? "")
        ? [`forbidden tool was selected: ${actualTool}`]
        : []),
      ...(fixture.expectedTool === undefined
        ? []
        : fixture.expectedTool === actualTool
          ? []
          : [`tool should be ${fixture.expectedTool ?? "(none)"}, got ${actualTool ?? "(none)"}`]),
      ...(fixture.expectedStop && result.exec?.stopReason !== fixture.expectedStop
        ? [`stop should be ${fixture.expectedStop}, got ${result.exec?.stopReason ?? "(none)"}`]
        : []),
      ...(fixture.expectedState && actualState !== fixture.expectedState
        ? [`state should be ${fixture.expectedState}, got ${actualState ?? "(none)"}`]
        : []),
      ...(fixture.validate?.(result) ?? []),
    ];
    const ok = errors.length === 0;
    const mark = ok ? "ok" : "not ok";
    console.log(
      `${mark} - ${fixture.name}: gate=${result.gateDecision.decision} tool=${actualTool ?? "(none)"} state=${actualState ?? "(none)"} stop=${result.exec?.stopReason ?? "(none)"}`,
    );
    for (const err of errors) console.log(`  - ${err}`);
    for (const line of result.debugLines) console.log(`  ${line}`);
    return ok;
  } finally {
    await cleanupConfirmSession(sessionId);
  }
}

async function main() {
  let passed = 0;
  for (let i = 0; i < fixtures.length; i++) {
    if (await runFixture(fixtures[i]!, i)) passed++;
  }
  console.log(`\n${passed}/${fixtures.length} tool orchestrator LLM fixtures passed (required ${MIN_PASS})`);
  if (passed < MIN_PASS) process.exitCode = 1;
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
