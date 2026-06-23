import type Anthropic from "@anthropic-ai/sdk";
import { sql } from "@/db/client";
import { callLlm } from "@/lib/llm";
import { createDispatchLedger } from "@/lib/tools/dispatch";
import { runExecutor, type ExecutorComplete, type ExecutorOutcome } from "@/lib/tools/executor";
import { gcalCreateEvent } from "@/lib/tools/schedule/gcal_create_event";
import { gcalDeleteEvent } from "@/lib/tools/schedule/gcal_delete_event";
import { gcalListEvents } from "@/lib/tools/schedule/gcal_list_events";
import { addReminderTool } from "@/lib/tools/reminder/add_reminder";
import { addTodoTool } from "@/lib/tools/todo/add_todo";
import { saveNote } from "@/lib/tools/note/save_note";
import { gmailSearch } from "@/lib/tools/mail/gmail_search";
import { musicNowPlaying } from "@/lib/tools/music/music_now_playing";
import { listNews } from "@/lib/tools/news/list_news";
import { searchContactsTool } from "@/lib/tools/contact/search_contacts";
import type { ToolContext, ToolDef } from "@/lib/tools/types";

type Fixture = {
  name: string;
  recentHistory: Anthropic.MessageParam[];
  expectedTool: string | null;
  forbiddenTools?: string[];
  validate: (input: unknown) => string[];
};

const MIN_PASS = Number(process.env.EXECUTOR_LLM_EVAL_MIN_PASS ?? 13);
const runtimeFacts = [
  "現在日時: 2026-06-23 12:00 JST",
  "タイムゾーン: Asia/Tokyo",
  "相対日付: 今日=2026-06-23, 明日=2026-06-24, 明後日=2026-06-25",
  "ユーザーの現在地: 軽井沢",
].join("\n");

const ctx: ToolContext = {
  sessionId: `executor-llm-eval-${Date.now()}`,
  caller: { kind: "main" },
  mode: "normal",
  userUtterance: null,
  availabilityCache: new Map(),
};

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function textOf(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function stringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function cloneForEval(tool: ToolDef): ToolDef {
  return {
    ...tool,
    callableBy: [{ kind: "main" }],
    confirmationPolicy: "auto",
    isAvailable: undefined,
    availabilityKey: undefined,
    dedup: undefined,
    handler: async (input) => ({ ok: true, input }),
  };
}

function contains(input: unknown, pattern: RegExp): boolean {
  return pattern.test(stringify(input));
}

function firstOutcome(outcomes: ExecutorOutcome[]): ExecutorOutcome | null {
  return outcomes.find((o) => o.outcome.executionState === "executed") ?? outcomes[0] ?? null;
}

const tools = [
  cloneForEval(gcalCreateEvent),
  cloneForEval(gcalDeleteEvent),
  cloneForEval(gcalListEvents),
  cloneForEval(addReminderTool),
  cloneForEval(addTodoTool),
  cloneForEval(saveNote),
  cloneForEval(gmailSearch),
  cloneForEval(musicNowPlaying),
  cloneForEval(listNews),
  cloneForEval(searchContactsTool),
];

const fixtures: Fixture[] = [
  {
    name: "calendar read tomorrow",
    recentHistory: [{ role: "user", content: "明日の予定を教えて" }],
    expectedTool: "gcal_list_events",
    validate: (input) => {
      const i = asRecord(input);
      const errs: string[] = [];
      if (!contains(i.time_min, /2026-06-24/)) errs.push("time_min should be tomorrow");
      if (!contains(i.time_max, /2026-06-25|2026-06-24/)) errs.push("time_max should bound tomorrow");
      return errs;
    },
  },
  {
    name: "calendar search by keyword",
    recentHistory: [{ role: "user", content: "テストを含む予定を探して" }],
    expectedTool: "gcal_list_events",
    validate: (input) => {
      const i = asRecord(input);
      return textOf(i.q) === "テスト" || contains(i.q, /テスト/) ? [] : ["q should include テスト"];
    },
  },
  {
    name: "calendar create self-contained",
    recentHistory: [{ role: "user", content: "明日20時にテスト予定を入れて" }],
    expectedTool: "gcal_create_event",
    validate: (input) => {
      const i = asRecord(input);
      const errs: string[] = [];
      if (!contains(i.summary, /テスト/)) errs.push("summary should include テスト");
      if (!contains(i.start, /2026-06-24.*20/)) errs.push("start should be tomorrow 20:00 JST");
      if (!contains(i.end, /2026-06-24/)) errs.push("end should be tomorrow");
      return errs;
    },
  },
  {
    name: "calendar delete explicit event id",
    recentHistory: [{ role: "user", content: "予定 event_id abc123 を削除して" }],
    expectedTool: "gcal_delete_event",
    validate: (input) => {
      const i = asRecord(input);
      return textOf(i.event_id) === "abc123" ? [] : ["event_id should be abc123"];
    },
  },
  {
    name: "calendar create ambiguous no date",
    recentHistory: [{ role: "user", content: "予定入れといて" }],
    expectedTool: null,
    validate: () => [],
  },
  {
    name: "calendar delete without event id should not direct delete",
    recentHistory: [{ role: "user", content: "テスト予定を削除して" }],
    expectedTool: "gcal_list_events",
    forbiddenTools: ["gcal_delete_event"],
    validate: (input) => {
      const i = asRecord(input);
      return contains(i.q, /テスト/) ? [] : ["q should include テスト"];
    },
  },
  {
    name: "reminder create",
    recentHistory: [{ role: "user", content: "今日15時にコーラを買うリマインダーを追加して" }],
    expectedTool: "add_reminder",
    validate: (input) => {
      const i = asRecord(input);
      const errs: string[] = [];
      if (!contains(i.title, /コーラ/)) errs.push("title should include コーラ");
      if (!contains(i.base_at, /2026-06-23.*15/)) errs.push("base_at should be today 15:00 JST");
      return errs;
    },
  },
  {
    name: "reminder ambiguous no time",
    recentHistory: [{ role: "user", content: "リマインダー追加して" }],
    expectedTool: null,
    validate: () => [],
  },
  {
    name: "todo add",
    recentHistory: [{ role: "user", content: "ほしい物リストに3Dプリンターを入れて" }],
    expectedTool: "add_todo",
    validate: (input) => {
      const i = asRecord(input);
      return contains(i.title, /3Dプリンター|3Ｄプリンター/i) ? [] : ["title should include 3Dプリンター"];
    },
  },
  {
    name: "note save",
    recentHistory: [{ role: "user", content: "メモして。来週の会議では予算案を先に確認する" }],
    expectedTool: "save_note",
    validate: (input) => {
      const i = asRecord(input);
      return contains(i.body_md, /予算案/) ? [] : ["body_md should include 予算案"];
    },
  },
  {
    name: "history reference calendar create",
    recentHistory: [
      { role: "user", content: "明日は晴れるかな？晴れたらゴルフに行きたいと思ってる" },
      { role: "assistant", content: "明日の軽井沢は晴れそうです。" },
      { role: "user", content: "じゃあ、予定入れといて" },
      { role: "assistant", content: "開始時刻を教えていただけますか？" },
      { role: "user", content: "9時から。中軽井沢ゴルフクラブで" },
    ],
    expectedTool: "gcal_create_event",
    validate: (input) => {
      const i = asRecord(input);
      const errs: string[] = [];
      if (!contains(i.summary, /ゴルフ/)) errs.push("summary should include ゴルフ");
      if (!contains(i.location, /中軽井沢ゴルフクラブ/)) errs.push("location should include 中軽井沢ゴルフクラブ");
      if (!contains(i.start, /2026-06-24.*09|2026-06-24.*9/)) errs.push("start should be tomorrow 09:00 JST");
      return errs;
    },
  },
  {
    name: "gmail unread search",
    recentHistory: [{ role: "user", content: "Gmailで未読メールを探して" }],
    expectedTool: "gmail_search",
    validate: (input) => {
      const i = asRecord(input);
      return contains(i.query, /is:unread|unread/) ? [] : ["query should search unread mail"];
    },
  },
  {
    name: "music now playing",
    recentHistory: [{ role: "user", content: "今流れてる曲は？" }],
    expectedTool: "music_now_playing",
    validate: () => [],
  },
  {
    name: "news list",
    recentHistory: [{ role: "user", content: "ニュース見せて" }],
    expectedTool: "list_news",
    validate: () => [],
  },
  {
    name: "contact search",
    recentHistory: [{ role: "user", content: "連絡先から田中さん探して" }],
    expectedTool: "search_contacts",
    validate: (input) => {
      const i = asRecord(input);
      return contains(i.query, /田中/) ? [] : ["query should include 田中"];
    },
  },
];

const complete: ExecutorComplete = async ({ system, messages, tools: anthropicTools }) =>
  callLlm("executor", {
    system,
    messages,
    tools: anthropicTools,
    maxTokens: 1024,
    temperature: 0,
    retry: false,
  });

async function runFixture(fixture: Fixture): Promise<boolean> {
  const result = await runExecutor({
    recentHistory: fixture.recentHistory,
    runtimeFacts,
    tools,
    ctx,
    ledger: createDispatchLedger({ budget: 8 }),
    complete,
    singlePass: true,
    maxIter: 1,
  });
  const outcome = firstOutcome(result.outcomes);
  const actualTool = outcome?.toolName ?? "(none)";
  const input = outcome?.input;
  const errors = [
    ...(fixture.forbiddenTools?.includes(actualTool) ? [`forbidden tool was selected: ${actualTool}`] : []),
    ...(fixture.expectedTool === null
      ? outcome
        ? [`no tool should be executed, got ${actualTool}`]
        : []
      : actualTool === fixture.expectedTool
        ? []
        : [`tool should be ${fixture.expectedTool}`]),
    ...(fixture.expectedTool === null ? [] : fixture.validate(input)),
  ];
  const ok = errors.length === 0;
  const mark = ok ? "ok" : "not ok";
  console.log(
    `${mark} - ${fixture.name}: tool=${actualTool}/${fixture.expectedTool} stop=${result.stopReason} input=${stringify(input)}`,
  );
  for (const err of errors) console.log(`  - ${err}`);
  return ok;
}

async function main() {
  let passed = 0;
  for (const fixture of fixtures) {
    if (await runFixture(fixture)) passed++;
  }
  console.log(`\n${passed}/${fixtures.length} executor LLM fixtures passed (required ${MIN_PASS})`);
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
