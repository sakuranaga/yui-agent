/**
 * P2b テスト: runExecutor の mini-loop / 終了判定 / dispatchTool 統合。
 * LLM は mock complete で注入 (決定論的)。合成 ToolDef でモック handler、実 DB 非接触。
 *
 * 実行: docker compose exec -T web npx tsx scripts/test-executor.ts
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { ToolDef, ToolContext, ToolSurface } from "@/lib/tools/types";
import { createDispatchLedger } from "@/lib/tools/dispatch";
import { runExecutor, aggregateForReport, type ExecutorComplete, type ExecutorOutcome } from "@/lib/tools/executor";

let pass = 0;
let fail = 0;
function check(cond: boolean, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log("  ❌", msg);
  }
}

const ctx: ToolContext = {
  sessionId: "executor-test",
  caller: { kind: "main" },
  mode: "normal",
  userUtterance: null,
  availabilityCache: new Map(),
};

function mkTool(name: string, surface: ToolSurface, handler: ToolDef["handler"]): ToolDef {
  return {
    name,
    description: "",
    input_schema: { type: "object", properties: {} },
    handler,
    callableBy: [{ kind: "main" }],
    surface,
    domain: "todo",
    allowedModes: ["normal"],
    confirmationPolicy: "auto",
  };
}

function msg(content: Anthropic.ContentBlock[]): Anthropic.Message {
  return {
    id: "m",
    type: "message",
    role: "assistant",
    content,
    model: "mock",
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  } as unknown as Anthropic.Message;
}
function toolUse(name: string, input: unknown, id = "t1"): Anthropic.ContentBlock {
  return { type: "tool_use", id, name, input } as unknown as Anthropic.ContentBlock;
}
function textBlock(text: string): Anthropic.ContentBlock {
  return { type: "text", text } as unknown as Anthropic.ContentBlock;
}

/** 呼ばれるたびに responses[i] を返す。尽きたら空 (tool 無し)。 */
function scripted(responses: Anthropic.Message[]): ExecutorComplete {
  let i = 0;
  return async () => responses[i++] ?? msg([textBlock("")]);
}

const addTodo = mkTool("add_todo", "mutate", async () => ({ id: "T-1" }));
const addReminder = mkTool("add_reminder", "mutate", async () => ({ ok: true }));
const listTodos = mkTool("list_todos", "read", async () => ({ todos: [] }));

async function main() {
  // 1. 行動意図なし (ack が雑談で完結) → ツール呼ばず no_tool_calls
  {
    const ledger = createDispatchLedger();
    const r = await runExecutor({
      recentHistory: [{ role: "user", content: "元気？" }],
      tools: [addTodo, listTodos],
      ctx,
      ledger,
      complete: scripted([msg([textBlock("")])]),
    });
    check(r.stopReason === "no_tool_calls", `雑談で no_tool_calls にならない (${r.stopReason})`);
    check(r.outcomes.length === 0, "雑談でツールが実行された");
    check(r.iterations === 1, `iterations が 1 でない (${r.iterations})`);
  }

  // 2. 単発 silent tool → executed / disposition silent
  {
    const ledger = createDispatchLedger();
    const r = await runExecutor({
      recentHistory: [{ role: "user", content: "牛乳買うのメモして" }],
      tools: [addTodo],
      ctx,
      ledger,
      complete: scripted([msg([toolUse("add_todo", { title: "牛乳" })]), msg([textBlock("")])]),
    });
    check(r.outcomes.length === 1, `outcomes が 1 でない (${r.outcomes.length})`);
    check(r.outcomes[0]?.outcome.executionState === "executed", "add_todo が executed でない");
    check(r.outcomes[0]?.outcome.disposition === "silent", "add_todo の disposition が silent でない");
    check(r.stopReason === "no_tool_calls", `stopReason が no_tool_calls でない (${r.stopReason})`);
  }

  // 3. 依存ツール: add_todo → 結果 id を読んで add_reminder (mini-loop が結果を戻す)
  {
    const ledger = createDispatchLedger();
    // complete は messages を見て、前 iter の tool_result から id を取り出す
    const complete: ExecutorComplete = async ({ messages }) => {
      const sawTodo = JSON.stringify(messages).includes("add_todo");
      const sawTodoResult = JSON.stringify(messages).includes("T-1");
      if (!sawTodo) return msg([toolUse("add_todo", { title: "ジム" }, "a1")]);
      if (sawTodoResult && !JSON.stringify(messages).includes("add_reminder"))
        return msg([toolUse("add_reminder", { ref_todo_id: "T-1" }, "a2")]);
      return msg([textBlock("")]);
    };
    const r = await runExecutor({
      recentHistory: [{ role: "user", content: "ジムのTODO作って、忘れないようリマインダーも" }],
      tools: [addTodo, addReminder],
      ctx,
      ledger,
      complete,
    });
    const names = r.outcomes.map((o) => o.toolName);
    check(names.includes("add_todo") && names.includes("add_reminder"), `依存ツールが両方実行されない (${names.join(",")})`);
    check(r.outcomes.every((o) => o.outcome.executionState === "executed"), "依存ツールが executed でない");
    check(r.iterations === 3, `依存解決の iterations が 3 でない (${r.iterations})`);
  }

  // 4. max_iter: 常に tool_use を返す → MAX_TOOL_ITER 打ち切り
  {
    const ledger = createDispatchLedger({ budget: 100 });
    let n = 0;
    const complete: ExecutorComplete = async () => msg([toolUse("list_todos", { n: n++ }, `id${n}`)]);
    const r = await runExecutor({
      recentHistory: [{ role: "user", content: "x" }],
      tools: [listTodos],
      ctx,
      ledger,
      complete,
      maxIter: 4,
    });
    check(r.stopReason === "max_iter", `max_iter で止まらない (${r.stopReason})`);
    check(r.iterations === 4, `max_iter 時の iterations が 4 でない (${r.iterations})`);
  }

  // 5. no_progress: 同一 mutation を繰り返す → 2 回目以降 duplicate skip → 進捗なしで停止
  {
    const ledger = createDispatchLedger();
    const complete: ExecutorComplete = async () => msg([toolUse("add_todo", { title: "同じ" }, "dup")]);
    const r = await runExecutor({
      recentHistory: [{ role: "user", content: "x" }],
      tools: [addTodo],
      ctx,
      ledger,
      complete,
      maxIter: 8,
    });
    // iter1: executed (anyProgress) → iter2: duplicate skip (全 skip) → no_progress
    check(r.stopReason === "no_progress", `no_progress で止まらない (${r.stopReason})`);
    check(r.iterations === 2, `no_progress の iterations が 2 でない (${r.iterations})`);
    const executed = r.outcomes.filter((o) => o.outcome.executionState === "executed").length;
    check(executed === 1, `重複 mutation が ${executed} 回実行された (1 のはず)`);
  }

  // 6. unknown tool → failed outcome
  {
    const ledger = createDispatchLedger();
    const r = await runExecutor({
      recentHistory: [{ role: "user", content: "x" }],
      tools: [addTodo],
      ctx,
      ledger,
      complete: scripted([msg([toolUse("nonexistent_tool", {})]), msg([textBlock("")])]),
    });
    check(r.outcomes[0]?.outcome.executionState === "failed", "unknown tool が failed でない");
    check(r.outcomes[0]?.outcome.result.is_error === true, "unknown tool 結果に is_error が無い");
  }

  // 7. budget 枯渇 → budget 停止
  {
    const ledger = createDispatchLedger({ budget: 1 });
    let n = 0;
    const complete: ExecutorComplete = async () => msg([toolUse("list_todos", { n: n++ }, `b${n}`)]);
    const r = await runExecutor({ recentHistory: [{ role: "user", content: "x" }], tools: [listTodos], ctx, ledger, complete, maxIter: 8 });
    check(r.stopReason === "budget", `budget で止まらない (${r.stopReason})`);
  }

  // 8. report tool の disposition
  {
    const ledger = createDispatchLedger();
    const r = await runExecutor({
      recentHistory: [{ role: "user", content: "TODO見せて" }],
      tools: [listTodos],
      ctx,
      ledger,
      complete: scripted([msg([toolUse("list_todos", {})]), msg([textBlock("")])]),
    });
    check(r.outcomes[0]?.outcome.disposition === "report", "list_todos の disposition が report でない");
  }

  // 9. pending_confirmation → loop 停止 (confirm flow に委ねる)
  {
    const confirmTool = mkTool("del_thing", "mutate", async () => ({ ok: true }));
    confirmTool.confirmationPolicy = "confirm_destructive";
    const pendingCtx: ToolContext = { ...ctx, sessionId: `executor-pending-${Date.now()}` };
    const ledger = createDispatchLedger();
    let calls = 0;
    const complete: ExecutorComplete = async () => {
      calls++;
      return msg([toolUse("del_thing", { id: "x" }, "d1")]);
    };
    const r = await runExecutor({ recentHistory: [{ role: "user", content: "消して" }], tools: [confirmTool], ctx: pendingCtx, ledger, complete, maxIter: 8 });
    check(r.stopReason === "pending_confirmation", `pending で止まらない (${r.stopReason})`);
    check(r.outcomes[0]?.outcome.executionState === "pending_confirmation", "confirm tool が pending_confirmation でない");
    check(calls === 1, `pending 後も LLM を再呼び出しした (${calls} 回)`);
  }

  // 10. Executor の text は履歴に積まれない (tool_use のみ。模倣汚染防止)
  {
    const ledger = createDispatchLedger();
    const flag = { leaked: true, iter2Ran: false }; // iter2 で leaked=false になれば OK
    const complete: ExecutorComplete = async ({ messages }) => {
      const turn = JSON.stringify(messages);
      if (!turn.includes("list_todos")) {
        // iter1: text + tool_use を混ぜて返す
        return msg([textBlock("LEAK_MARKER_本文"), toolUse("list_todos", {}, "l1")]);
      }
      // iter2: 履歴に LEAK_MARKER が残っていないこと
      flag.iter2Ran = true;
      flag.leaked = turn.includes("LEAK_MARKER");
      return msg([textBlock("")]);
    };
    await runExecutor({ recentHistory: [{ role: "user", content: "x" }], tools: [listTodos], ctx, ledger, complete });
    check(flag.iter2Ran && !flag.leaked, "Executor の text 本文が履歴に漏れている (模倣汚染)");
  }

  // 11. 1 応答内の大量 unknown も budget を消費する (バイパス防止)
  {
    const ledger = createDispatchLedger({ budget: 2 });
    const complete: ExecutorComplete = async () =>
      msg([toolUse("u1", {}, "x1"), toolUse("u2", {}, "x2"), toolUse("u3", {}, "x3")]);
    const r = await runExecutor({ recentHistory: [{ role: "user", content: "x" }], tools: [addTodo], ctx, ledger, complete, maxIter: 2 });
    const skippedBudget = r.outcomes.filter((o) => o.outcome.skipReason === "budget").length;
    check(skippedBudget >= 1, "unknown tool が budget を消費していない (3件目が skip されるべき)");
    check(r.stopReason === "budget", `unknown 大量で budget 停止しない (${r.stopReason})`);
  }

  // 12. 同一 unknown の反復は no_progress で止まる
  {
    const ledger = createDispatchLedger({ budget: 100 });
    const complete: ExecutorComplete = async () => msg([toolUse("same_unknown", { a: 1 }, "u")]);
    const r = await runExecutor({ recentHistory: [{ role: "user", content: "x" }], tools: [addTodo], ctx, ledger, complete, maxIter: 8 });
    check(r.stopReason === "no_progress", `同一 unknown 反復が no_progress で止まらない (${r.stopReason})`);
    check(r.iterations === 2, `同一 unknown 反復の iterations が 2 でない (${r.iterations})`);
  }

  // 13. specialist umbrella (extra tool) → onExtraTool 橋渡し (§5.4.1)
  {
    const ledger = createDispatchLedger();
    const specialistTool = { name: "ask_mail_specialist", description: "メール", input_schema: { type: "object", properties: { query: { type: "string" } } } } as unknown as Anthropic.Tool;
    let bridged: { id: string; name: string; input: unknown } | null = null;
    const onExtraTool = async (tu: { id: string; name: string; input: unknown }) => {
      bridged = tu;
      return { executionState: "executed" as const, disposition: "silent" as const, result: { type: "tool_result" as const, tool_use_id: tu.id, content: JSON.stringify({ dispatched: true }) } };
    };
    const r = await runExecutor({
      recentHistory: [{ role: "user", content: "未読メール教えて" }],
      tools: [],
      ctx,
      ledger,
      complete: scripted([msg([toolUse("ask_mail_specialist", { query: "未読" }, "s1")]), msg([textBlock("")])]),
      extraTools: [specialistTool],
      onExtraTool,
    });
    check(bridged !== null && (bridged as { name: string }).name === "ask_mail_specialist", "specialist が onExtraTool へ橋渡しされない");
    check(r.outcomes[0]?.outcome.executionState === "executed", "specialist outcome が executed でない");
    check(r.outcomes[0]?.outcome.disposition === "silent", "specialist 成功が silent でない (C 二重起動防止)");
  }

  // 14. extra tool を渡しても onExtraTool 無しなら unknown 扱い
  {
    const ledger = createDispatchLedger();
    const specialistTool = { name: "ask_mail_specialist", description: "", input_schema: { type: "object", properties: {} } } as unknown as Anthropic.Tool;
    const r = await runExecutor({
      recentHistory: [{ role: "user", content: "x" }], tools: [], ctx, ledger,
      complete: scripted([msg([toolUse("ask_mail_specialist", {}, "s")]), msg([textBlock("")])]),
      extraTools: [specialistTool], // onExtraTool 無し
    });
    check(r.outcomes[0]?.outcome.executionState === "failed", "onExtraTool 無しで extra tool が failed(unknown) にならない");
  }

  // 15. 同一 specialist の二重 dispatch 抑止 (Codex P3 High)
  {
    const ledger = createDispatchLedger();
    const specialistTool = { name: "ask_mail_specialist", description: "", input_schema: { type: "object", properties: {} } } as unknown as Anthropic.Tool;
    let calls = 0;
    const onExtraTool = async (tu: { id: string; name: string; input: unknown }) => {
      calls++;
      return { executionState: "executed" as const, disposition: "silent" as const, result: { type: "tool_result" as const, tool_use_id: tu.id, content: "{}" } };
    };
    // 毎 iter 同じ specialist call を返す
    const complete: ExecutorComplete = async () => msg([toolUse("ask_mail_specialist", { q: "同じ" }, "s")]);
    const r = await runExecutor({ recentHistory: [{ role: "user", content: "x" }], tools: [], ctx, ledger, complete, extraTools: [specialistTool], onExtraTool, maxIter: 8 });
    check(calls === 1, `specialist が ${calls} 回 dispatch された (1 のはず=二重抑止)`);
    check(r.stopReason === "no_progress", `specialist 重複が no_progress で止まらない (${r.stopReason})`);
  }

  // 16. onExtraTool の例外 → failed に落として route を落とさない (Codex P3 Medium)
  {
    const ledger = createDispatchLedger();
    const specialistTool = { name: "ask_mail_specialist", description: "", input_schema: { type: "object", properties: {} } } as unknown as Anthropic.Tool;
    const onExtraTool = async () => { throw new Error("dispatch 失敗"); };
    let threw = false;
    let state = "";
    try {
      const r = await runExecutor({ recentHistory: [{ role: "user", content: "x" }], tools: [], ctx, ledger, complete: scripted([msg([toolUse("ask_mail_specialist", {}, "s")]), msg([textBlock("")])]), extraTools: [specialistTool], onExtraTool });
      state = r.outcomes[0]?.outcome.executionState ?? "";
    } catch { threw = true; }
    check(!threw, "onExtraTool の例外で runExecutor が reject した (route 全体が落ちる)");
    check(state === "failed", `onExtraTool 例外が failed にならない (${state})`);
  }

  // 17. extra tool が registry 名と衝突 → registry (dispatchTool) 優先、onExtraTool 呼ばれない
  {
    const ledger = createDispatchLedger();
    const collide = { name: "add_todo", description: "", input_schema: { type: "object", properties: {} } } as unknown as Anthropic.Tool;
    let extraCalled = false;
    const onExtraTool = async (tu: { id: string; name: string; input: unknown }) => { extraCalled = true; return { executionState: "executed" as const, disposition: "silent" as const, result: { type: "tool_result" as const, tool_use_id: tu.id, content: "{}" } }; };
    const r = await runExecutor({ recentHistory: [{ role: "user", content: "x" }], tools: [addTodo], ctx, ledger, complete: scripted([msg([toolUse("add_todo", { title: "z" }, "a")]), msg([textBlock("")])]), extraTools: [collide], onExtraTool });
    check(extraCalled === false, "registry 名衝突で onExtraTool が呼ばれた (registry 優先のはず)");
    check(r.outcomes[0]?.outcome.executionState === "executed", "衝突時に registry tool が実行されない");
  }

  // 18. specialist 二重抑止は key 順非依存 (Codex P3 Low: stableStringify 共有)
  {
    const ledger = createDispatchLedger();
    const specialistTool = { name: "ask_mail_specialist", description: "", input_schema: { type: "object", properties: {} } } as unknown as Anthropic.Tool;
    let calls = 0;
    const onExtraTool = async (tu: { id: string; name: string; input: unknown }) => { calls++; return { executionState: "executed" as const, disposition: "silent" as const, result: { type: "tool_result" as const, tool_use_id: tu.id, content: "{}" } }; };
    let n = 0;
    const inputs = [{ a: 1, b: 2 }, { b: 2, a: 1 }]; // 同内容・キー順違い
    const complete: ExecutorComplete = async () => msg([toolUse("ask_mail_specialist", inputs[n++] ?? {}, "s")]);
    const r = await runExecutor({ recentHistory: [{ role: "user", content: "x" }], tools: [], ctx, ledger, complete, extraTools: [specialistTool], onExtraTool, maxIter: 8 });
    check(calls === 1, `key 順違いの同一 specialist が ${calls} 回 dispatch された (1 のはず)`);
    check(r.stopReason === "no_progress", "key 順違い重複が no_progress で止まらない");
  }

  // 19. aggregateForReport: silent 除外 / report 含む / 失敗・pending 含む / 打ち切り通知
  {
    const mk = (toolName: string, executionState: ExecutorOutcome["outcome"]["executionState"], disposition: "silent" | "report", content = "{}", skipReason?: "budget" | "depth" | "duplicate"): ExecutorOutcome =>
      ({ toolName, outcome: { executionState, disposition, result: { type: "tool_result", tool_use_id: "x", content }, skipReason } });

    // silent 成功のみ → needsC false
    const a1 = aggregateForReport([mk("add_todo", "executed", "silent")], "no_tool_calls");
    check(a1.needsC === false, "silent 成功のみで needsC が true");

    // report 成功 → 含む
    const a2 = aggregateForReport([mk("list_todos", "executed", "report", '{"todos":["牛乳"]}')], "no_tool_calls");
    check(a2.needsC === true && a2.text.includes("list_todos"), "report 成功が C に含まれない");

    // 失敗 → 含む
    const a3 = aggregateForReport([mk("add_todo", "failed", "silent", '{"error":"x"}')], "no_tool_calls");
    check(a3.needsC === true && a3.text.includes("失敗"), "失敗が C に含まれない");

    // silent 成功 + budget 打ち切り → 通知で needsC true
    const a4 = aggregateForReport([mk("add_todo", "executed", "silent"), mk("add_todo", "skipped", "silent", "{}", "budget")], "budget");
    check(a4.needsC === true && a4.text.includes("完了していません"), "打ち切りが C に通知されない");
  }

  // 20. runtimeFacts が #2 の system に trusted で載る (v3 High②)
  {
    const ledger = createDispatchLedger();
    let sawFacts = false;
    const complete: ExecutorComplete = async ({ system }) => {
      sawFacts = system.includes("現在の状況") && system.includes("FACT_MARKER_2026");
      return msg([textBlock("")]);
    };
    await runExecutor({
      recentHistory: [{ role: "user", content: "明日6時にアラーム" }],
      runtimeFacts: "現在時刻: FACT_MARKER_2026-06-17 15:00 JST\nmode: normal",
      tools: [addTodo],
      ctx,
      ledger,
      complete,
    });
    check(sawFacts, "runtimeFacts が Executor の system に trusted で載っていない");
  }

  console.log(`\n=== 結果: ${pass} pass / ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
