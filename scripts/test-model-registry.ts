/**
 * モデルレジストリ M1 のテスト (#206)。
 * CRUD / tier KV / base 正規化 / seed の冪等性を検証。
 * Usage (container 内): npx tsx scripts/test-model-registry.ts
 */
import {
  listModels,
  getModel,
  createModel,
  updateModel,
  deleteModel,
  getTierAssignment,
  setTierAssignment,
  normalizeOpenAiBase,
  seedModelRegistryIfEmpty,
} from "@/lib/model-registry";
import { getAiSetting } from "@/lib/ai-settings";

let passed = 0;
const failures: string[] = [];
function check(cond: boolean, msg: string) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  }
}

async function main() {
  const createdIds: string[] = [];
  // tier 割当は実データなので snapshot して最後に復元
  const origAssignmentRaw = await getAiSetting("model_tier_assignment");

  try {
    // --- 1. normalizeOpenAiBase (純粋) ---
    console.log("[1] normalizeOpenAiBase");
    check(
      normalizeOpenAiBase("http://llm:8081/v1/chat/completions") === "http://llm:8081/v1",
      "full endpoint → /v1 に正規化"
    );
    check(normalizeOpenAiBase("http://x/v1/") === "http://x/v1", "末尾スラッシュ除去");
    check(normalizeOpenAiBase("http://x/v1") === "http://x/v1", "base はそのまま");

    // --- 2. CRUD ---
    console.log("[2] CRUD");
    const e = await createModel({
      label: "テスト用 Opus",
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      apiKeyRef: "anthropic",
    });
    createdIds.push(e.id);
    check(e.id.length > 0 && e.provider === "anthropic", "createModel で id 採番");
    const got = await getModel(e.id);
    check(got?.modelId === "claude-opus-4-8", "getModel で取得");
    const upd = await updateModel(e.id, {
      label: "改名",
      capabilities: { reachable: true, supportsTools: true, testedAt: "2026-06-14T00:00:00Z" },
    });
    check(upd?.label === "改名", "updateModel で label 更新");
    check(upd?.capabilities.supportsTools === true, "capabilities 更新");
    const list = await listModels();
    check(list.some((m) => m.id === e.id), "listModels に出る");

    // local entry (base_url 付き)
    const local = await createModel({
      label: "テスト local",
      provider: "local_openai",
      modelId: "gemma-x",
      baseUrl: "http://llm:8081/v1",
      apiKeyRef: null,
    });
    createdIds.push(local.id);
    check(local.baseUrl === "http://llm:8081/v1" && local.apiKeyRef === null, "local_openai entry");

    // --- 3. tier 割当 KV ---
    console.log("[3] tier 割当");
    await setTierAssignment({ main: e.id, sub: local.id, heavy: e.id, tool: null });
    const a = await getTierAssignment();
    check(a.main === e.id && a.sub === local.id && a.heavy === e.id, "set→get で一致");
    check(JSON.parse((await getAiSetting("model_tier_assignment")) ?? "{}").main === e.id, "ai_settings に JSON 保存");

    // --- 4. seed 冪等性 (実テーブルを壊さない) ---
    console.log("[4] seed 冪等性");
    // 既に entry がある (上で作った) ので seed は 0 件
    const s1 = await seedModelRegistryIfEmpty();
    check(s1.seeded === 0, "registry 非空なら seed しない (idempotent)");
    check((await listModels()).length > 0, "registry は非空のまま");

    // --- delete ---
    console.log("[5] delete");
    check(await deleteModel(local.id), "deleteModel 成功");
    createdIds.splice(createdIds.indexOf(local.id), 1);
    check((await getModel(local.id)) === null, "削除後は取得不可");
  } finally {
    for (const id of createdIds) await deleteModel(id).catch(() => {});
    // tier 割当を復元
    const { updateAiSettings } = await import("@/lib/ai-settings");
    await updateAiSettings({ model_tier_assignment: origAssignmentRaw ?? "" }).catch(() => {});
  }

  console.log(`\n=== ${passed} passed, ${failures.length} failed ===`);
  if (failures.length) {
    console.log("FAILED:\n" + failures.map((f) => `  - ${f}`).join("\n"));
    process.exit(1);
  }
  console.log("✅ all green");
  process.exit(0);
}

main().catch((e) => {
  console.error("[test-model-registry] threw:", e);
  process.exit(1);
});
