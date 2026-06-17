/**
 * P2a テスト: dispatchTool ゲートウェイの executionState / idempotency / budget / depth。
 * 副作用を避けるため合成 ToolDef (モック handler) を使う。実 DB は触らない。
 *
 * 実行: docker compose exec -T web npx tsx scripts/test-tool-dispatch-gateway.ts
 */
import type { ToolDef, ToolContext, ToolSurface } from "@/lib/tools/types";
import { dispatchTool, createDispatchLedger } from "@/lib/tools/dispatch";

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
  sessionId: "dispatch-gateway-test",
  caller: { kind: "main" },
  mode: "normal",
  userUtterance: null,
  availabilityCache: new Map(),
};

function mkTool(
  name: string,
  surface: ToolSurface,
  handler: ToolDef["handler"],
  extra: Partial<ToolDef> = {}
): ToolDef {
  return {
    name,
    description: "",
    input_schema: {},
    handler,
    callableBy: [{ kind: "main" }],
    surface,
    domain: "todo",
    allowedModes: ["normal"],
    confirmationPolicy: "auto",
    ...extra,
  };
}

const okHandler: ToolDef["handler"] = async () => ({ ok: true });
const throwHandler: ToolDef["handler"] = async () => {
  throw new Error("boom");
};

const silentMutate = mkTool("m_mutate", "mutate", okHandler);
const readTool = mkTool("m_read", "read", okHandler);
const transportTool = mkTool("m_transport", "transport", okHandler);
const failTool = mkTool("m_fail", "mutate", throwHandler);

async function main() {
  // 1. mutate 実行 → executed / disposition silent / 台帳に登録
  {
    const ledger = createDispatchLedger();
    const r = await dispatchTool(silentMutate, { id: "1", input: { a: 1 } }, ctx, ledger);
    check(r.executionState === "executed", `mutate が executed でない (${r.executionState})`);
    check(r.disposition === "silent", `mutate の disposition が silent でない (${r.disposition})`);
    check(ledger.executedMutations.size === 1, "mutate が台帳に登録されていない");

    // 2. 同一 mutate 再実行 → skipped(duplicate)
    const r2 = await dispatchTool(silentMutate, { id: "2", input: { a: 1 } }, ctx, ledger);
    check(r2.executionState === "skipped" && r2.skipReason === "duplicate", `同一 mutate が duplicate skip されない (${r2.executionState}/${r2.skipReason})`);

    // 3. 異なる input の mutate → executed (別キー)
    const r3 = await dispatchTool(silentMutate, { id: "3", input: { a: 2 } }, ctx, ledger);
    check(r3.executionState === "executed", "異なる input の mutate が実行されない");

    // キー順非依存 (idempotency キーは正規化される)
    const r4 = await dispatchTool(silentMutate, { id: "4", input: { a: 1 } }, ctx, ledger);
    check(r4.skipReason === "duplicate", "キー順非依存の重複検出が効いていない");
  }

  // 4. read は idempotency 対象外 → 何度でも executed
  {
    const ledger = createDispatchLedger();
    const r1 = await dispatchTool(readTool, { id: "1", input: { q: "x" } }, ctx, ledger);
    const r2 = await dispatchTool(readTool, { id: "2", input: { q: "x" } }, ctx, ledger);
    check(r1.executionState === "executed" && r2.executionState === "executed", "read の再実行が弾かれている");
    check(r1.disposition === "report", `read の disposition が report でない (${r1.disposition})`);
    check(ledger.executedMutations.size === 0, "read が idempotency 台帳に登録されてしまっている");
  }

  // 5. transport も idempotency 対象外 (繰り返し可)
  {
    const ledger = createDispatchLedger();
    await dispatchTool(transportTool, { id: "1", input: {} }, ctx, ledger);
    const r2 = await dispatchTool(transportTool, { id: "2", input: {} }, ctx, ledger);
    check(r2.executionState === "executed", "transport の再実行が弾かれている");
  }

  // 6. handler エラー → failed / 台帳に登録しない (再試行可)
  {
    const ledger = createDispatchLedger();
    const r1 = await dispatchTool(failTool, { id: "1", input: { a: 1 } }, ctx, ledger);
    check(r1.executionState === "failed", `エラーが failed でない (${r1.executionState})`);
    check(r1.result.is_error === true, "失敗結果に is_error が立っていない");
    check(ledger.executedMutations.size === 0, "失敗 mutation が台帳に登録された (再試行不可になる)");
    const r2 = await dispatchTool(failTool, { id: "2", input: { a: 1 } }, ctx, ledger);
    check(r2.executionState === "failed", "失敗 mutation の再試行が duplicate skip された");
  }

  // 7. budget 枯渇 → skipped(budget)
  {
    const ledger = createDispatchLedger({ budget: 1 });
    const r1 = await dispatchTool(readTool, { id: "1", input: { q: "a" } }, ctx, ledger);
    const r2 = await dispatchTool(readTool, { id: "2", input: { q: "b" } }, ctx, ledger);
    check(r1.executionState === "executed", "budget=1 の1回目が実行されない");
    check(r2.executionState === "skipped" && r2.skipReason === "budget", `budget 枯渇が skip(budget) でない (${r2.executionState}/${r2.skipReason})`);
  }

  // 8. depth 上限 → skipped(depth) (depth は引数で渡す)
  {
    const ledger = createDispatchLedger({ maxDepth: 1 });
    const r0 = await dispatchTool(readTool, { id: "0", input: {} }, ctx, ledger, 1); // depth=1 == maxDepth → 通る
    check(r0.executionState === "executed", "depth==maxDepth が弾かれている");
    const r = await dispatchTool(readTool, { id: "1", input: {} }, ctx, ledger, 2); // depth=2 > 1 → skip
    check(r.executionState === "skipped" && r.skipReason === "depth", `depth 超過が skip(depth) でない (${r.executionState}/${r.skipReason})`);
  }

  // 9. budget は depth を跨いで共有 (High 修正: 同一 ledger を回す)
  {
    const ledger = createDispatchLedger({ budget: 2 });
    await dispatchTool(readTool, { id: "1", input: { q: "a" } }, ctx, ledger, 0); // 親階層
    await dispatchTool(readTool, { id: "2", input: { q: "b" } }, ctx, ledger, 1); // 子階層 (depth+1)
    const r3 = await dispatchTool(readTool, { id: "3", input: { q: "c" } }, ctx, ledger, 1); // 3回目 → budget 枯渇
    check(r3.executionState === "skipped" && r3.skipReason === "budget", `budget が階層跨ぎで共有されていない (${r3.executionState}/${r3.skipReason})`);
  }

  // 10. undefined と null は別 idempotency key (Low 修正)
  {
    const ledger = createDispatchLedger();
    const r1 = await dispatchTool(silentMutate, { id: "1", input: { a: undefined } }, ctx, ledger);
    const r2 = await dispatchTool(silentMutate, { id: "2", input: { a: null } }, ctx, ledger);
    check(r1.executionState === "executed" && r2.executionState === "executed", "undefined と null が同一 key 扱いされている");
  }

  // 11. 循環参照 input でも throw せず処理する (Low 修正: 単一ゲートウェイ契約)
  {
    const ledger = createDispatchLedger();
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    let threw = false;
    let state = "";
    try {
      const r = await dispatchTool(silentMutate, { id: "1", input: circular }, ctx, ledger);
      state = r.executionState;
    } catch {
      threw = true;
    }
    check(!threw, "循環参照 input で dispatchTool が throw した (契約違反)");
    check(state === "executed", `循環参照 input が executed にならない (${state})`);
  }

  // 12. 並列同一 mutation → 1 本だけ executed、残りは duplicate skip (Codex High: 実行前予約)
  {
    const ledger = createDispatchLedger();
    let runs = 0;
    const slowMutate = mkTool("m_slow", "mutate", async () => {
      runs++;
      await Promise.resolve();
      return { ok: true };
    });
    const results = await Promise.all([
      dispatchTool(slowMutate, { id: "1", input: { a: 1 } }, ctx, ledger),
      dispatchTool(slowMutate, { id: "2", input: { a: 1 } }, ctx, ledger),
      dispatchTool(slowMutate, { id: "3", input: { a: 1 } }, ctx, ledger),
    ]);
    const executed = results.filter((r) => r.executionState === "executed").length;
    const dup = results.filter((r) => r.skipReason === "duplicate").length;
    check(executed === 1, `並列同一 mutation で executed が ${executed} 件 (1 であるべき)`);
    check(dup === 2, `並列同一 mutation で duplicate skip が ${dup} 件 (2 であるべき)`);
    check(runs === 1, `handler が ${runs} 回実行された (二重実行防止できていない)`);
  }

  console.log(`\n=== 結果: ${pass} pass / ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
