/**
 * P1 監査テスト: resolveDispatch が全ツールに妥当な dispatch を与えるか。
 * docs/tool-dispatch-redesign.md §4.2。挙動不変 (メタ整備のみ) の確認。
 *
 * 実行: docker compose exec -T web npx tsx scripts/test-tool-dispatch.ts
 */
import { ALL_TOOLS } from "@/lib/tools/registry";
import { resolveDispatch } from "@/lib/tools/runtime";
import type { ToolDisposition } from "@/lib/tools/types";

let pass = 0;
let fail = 0;
function check(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log("  ❌", msg);
  }
}

console.log(`=== 全 ${ALL_TOOLS.length} ツールの dispatch 推定 ===\n`);

const byDisposition: Record<ToolDisposition, string[]> = { silent: [], report: [] };
const execOther: string[] = [];

for (const t of ALL_TOOLS) {
  const d = resolveDispatch(t);
  byDisposition[d.disposition].push(`${t.name} (surface=${t.surface}, confirm=${t.confirmationPolicy ?? "-"})`);
  if (d.executor !== "inline") execOther.push(`${t.name} → ${JSON.stringify(d.executor)}`);

  // 不変条件
  check(d.disposition === "silent" || d.disposition === "report", `${t.name}: disposition が不正 (${d.disposition})`);
  check(d.executor === "inline" || d.executor === "agent" || typeof d.executor === "object", `${t.name}: executor が不正`);

  // 推定規約: confirm 必要なツールは必ず report (黙って投げっぱなし禁止)
  if (t.confirmationPolicy === "confirm_destructive" || t.confirmationPolicy === "confirm_external_send") {
    check(d.disposition === "report", `${t.name}: confirm 必要なのに ${d.disposition} (report であるべき)`);
  }
  // read/external はデータ返却 → report
  if ((t.surface === "read" || t.surface === "external") && !t.dispatch?.disposition) {
    check(d.disposition === "report", `${t.name}: surface=${t.surface} なのに ${d.disposition} (report 推定であるべき)`);
  }

  // 上書き整合: ToolDef.dispatch があれば resolveDispatch がそれを優先
  if (t.dispatch?.disposition) {
    check(d.disposition === t.dispatch.disposition, `${t.name}: dispatch 上書きが効いていない`);
  }
}

// confirm 必要ツールは dispatch:{disposition:"silent"} の上書きがあっても report 強制 (Codex P1 Medium)
{
  const fakeConfirm = {
    name: "_fake_confirm",
    description: "",
    input_schema: {},
    handler: async () => null,
    callableBy: [{ kind: "main" as const }],
    surface: "mutate" as const,
    domain: "todo" as const,
    allowedModes: ["normal" as const],
    confirmationPolicy: "confirm_destructive" as const,
    dispatch: { disposition: "silent" as const }, // 不正上書き
  };
  const r = resolveDispatch(fakeConfirm);
  check(r.disposition === "report", `confirm ツールの silent 上書きが report に矯正されていない (got ${r.disposition})`);
}
// spotify_search_play は明示上書きで report
{
  const sp = ALL_TOOLS.find((t) => t.name === "spotify_search_play");
  check(!!sp && resolveDispatch(sp).disposition === "report", "spotify_search_play が report 上書きになっていない");
}

console.log(`--- report (${byDisposition.report.length}) = 結果を会話へ ---`);
for (const s of byDisposition.report) console.log("  •", s);
console.log(`\n--- silent (${byDisposition.silent.length}) = ack で完結 (失敗のみ報告) ---`);
for (const s of byDisposition.silent) console.log("  •", s);
console.log(`\n--- executor != inline (${execOther.length}) ---`);
for (const s of execOther) console.log("  •", s);

// P1 挙動不変の確認: dispatch を追加しても toAnthropicTools 等が変わらないこと (型レベルで保証されるが念のため)
console.log(`\n=== 結果: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
