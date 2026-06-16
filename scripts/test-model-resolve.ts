/**
 * #206 M3 の検証: resolveTier / resolveEntry の優先順位、tier fallback 発火、
 * local-roles 移行。Usage (container 内): npx tsx scripts/test-model-resolve.ts
 *
 * 設計: docs/model-config-overhaul.md §8.5
 *
 * 注意: 実 DB の ai_settings (tier 割当 / fallback / role overrides / 移行フラグ) を
 *       一時的に書き換えるため、全テストを snapshot → finally restore で囲む。
 *       作成した registry entry も最後に削除する。
 */
import http from "node:http";
import type { AddressInfo } from "node:net";
import { resolveTier, resolveEntry, callLlm, type LlmRole } from "@/lib/llm";
import {
  createModel,
  deleteModel,
  listModels,
  setTierAssignment,
  setTierFallback,
  setRoleTierOverrides,
  migrateLocalRolesToTierOverrides,
  migrateIntentRolesToLocal,
  getRoleTierOverrides,
  getTierFallback,
} from "@/lib/model-registry";
import { getAiSetting, updateAiSettings, getLocalLlmConfig } from "@/lib/ai-settings";

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

/** OpenAI 互換 /chat/completions のミニマル mock (常に text "pong" を返す)。 */
function startMockServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "mock-1",
            model: "mock",
            choices: [{ index: 0, message: { role: "assistant", content: "pong-fallback" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          })
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) });
    });
  });
}

async function main() {
  // ── snapshot (restore 用) ──
  const snap = {
    assignment: await getAiSetting("model_tier_assignment"),
    fallback: await getAiSetting("model_tier_fallback"),
    overrides: await getAiSetting("role_tier_overrides"),
    migrated: await getAiSetting("model_local_roles_migrated"),
    intentMigrated: await getAiSetting("model_intent_roles_migrated"),
  };
  const createdIds: string[] = [];

  try {
    // ── 1. resolveTier 既定表 ──
    console.log("[1] resolveTier 既定表");
    const expect: Array<[LlmRole, string]> = [
      ["main", "main"], ["news_speak", "main"], ["diary", "main"], ["sleep_intro", "main"], ["profile_synth", "main"],
      ["voice", "sub"], ["judge", "sub"], ["report", "sub"], ["extract", "sub"], ["reconcile", "sub"],
      ["news_curate", "sub"], ["morning_speak", "sub"], ["mail_curate", "sub"], ["tts_normalize", "sub"],
      ["food_extract", "sub"], ["notify", "sub"],
      ["intent", "sub"], ["project_suggest", "sub"],
      ["specialist", "heavy"],
    ];
    for (const [role, tier] of expect) check(resolveTier(role) === tier, `${role} → ${tier}`);

    // ── テスト用 entry を 3 つ作る ──
    const tMain = await createModel({ label: "t-main", provider: "anthropic", modelId: "claude-sonnet-4-6", apiKeyRef: "anthropic" });
    const tSub = await createModel({ label: "t-sub", provider: "anthropic", modelId: "claude-haiku-4-5", apiKeyRef: "anthropic" });
    const tHeavy = await createModel({ label: "t-heavy", provider: "anthropic", modelId: "claude-opus-4-7", apiKeyRef: "anthropic" });
    createdIds.push(tMain.id, tSub.id, tHeavy.id);
    await setTierAssignment({ main: tMain.id, sub: tSub.id, heavy: tHeavy.id });
    await setRoleTierOverrides({});

    // ── 2. resolveEntry: 既定 tier 割当 ──
    console.log("[2] resolveEntry 既定 tier 割当");
    check((await resolveEntry("main")).entry.id === tMain.id, "main role → main entry");
    check((await resolveEntry("judge")).entry.id === tSub.id, "judge role → sub entry");
    check((await resolveEntry("specialist")).entry.id === tHeavy.id, "specialist role → heavy entry");
    check((await resolveEntry("judge")).tier === "sub", "judge tier = sub");

    // ── 3. resolveEntry: override (entry id / raw model string) ──
    console.log("[3] resolveEntry override");
    check((await resolveEntry("judge", tMain.id)).entry.id === tMain.id, "override = entry id → その entry");
    {
      const r = await resolveEntry("judge", "claude-haiku-4-5");
      check(r.entry.id.startsWith("ephemeral:"), "override = raw model string → ephemeral entry");
      check(r.entry.provider === "anthropic" && r.entry.modelId === "claude-haiku-4-5", "ephemeral provider/modelId 正しい");
    }

    // ── 4. resolveEntry: role_tier_overrides (entry id / tier 名 / 不正値) ──
    console.log("[4] resolveEntry role_tier_overrides");
    await setRoleTierOverrides({ judge: tHeavy.id });
    check((await resolveEntry("judge")).entry.id === tHeavy.id, "role override = entry id → その entry");
    check((await resolveEntry("judge")).tier === "sub", "entry-id override は role の tier を維持 (sub)");

    await setRoleTierOverrides({ judge: "heavy" });
    {
      const r = await resolveEntry("judge");
      check(r.entry.id === tHeavy.id, "role override = tier 名 'heavy' → heavy entry");
      check(r.tier === "heavy", "tier-name override は tier を heavy に変更");
    }

    await setRoleTierOverrides({ judge: "not-a-uuid-or-tier" });
    {
      const r = await resolveEntry("judge");
      check(r.entry.id === tSub.id, "role override 不正値 → 既定 tier (sub) に fallback");
    }
    await setRoleTierOverrides({});

    // ── 5. tier fallback 発火 (primary 死 → fallback entry で成功) ──
    console.log("[5] tier fallback 発火");
    {
      const mock = await startMockServer();
      // primary = 到達不能 local entry (閉じたポート)、fallback = mock local entry
      const dead = await createModel({ label: "t-dead", provider: "local_openai", modelId: "dead", baseUrl: "http://127.0.0.1:1/v1" });
      const live = await createModel({ label: "t-live", provider: "local_openai", modelId: "mock", baseUrl: mock.baseUrl });
      createdIds.push(dead.id, live.id);
      await setTierAssignment({ main: tMain.id, sub: dead.id, heavy: tHeavy.id });
      await setTierFallback({ main: null, sub: live.id, heavy: null });
      await setRoleTierOverrides({});

      const res = await callLlm("judge", {
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 16,
        retry: false, // primary を 1 発で失敗させ fallback へ
      });
      const text = res.content.filter((b) => b.type === "text").map((b) => (b.type === "text" ? b.text : "")).join("");
      check(text === "pong-fallback", "primary 死 → fallback entry が応答した");
      await mock.close();
    }

    // ── 6. local-roles 移行 ──
    console.log("[6] local-roles 移行 (migrateLocalRolesToTierOverrides)");
    {
      const local = await getLocalLlmConfig();
      if (!local.enabled || !local.url) {
        console.log("  (local 未使用環境 → 移行 skip 経路のみ確認)");
        await updateAiSettings({ model_local_roles_migrated: "" });
        const r = await migrateLocalRolesToTierOverrides();
        check(r.migrated === false, "local 未使用 → migrated=false");
        check((await getAiSetting("model_local_roles_migrated")) === "1", "フラグは立つ");
      } else {
        // フラグをクリアして移行を走らせる。assignment.sub は hosted (tSub) にしておく。
        await updateAiSettings({ model_local_roles_migrated: "" });
        await setTierAssignment({ main: tMain.id, sub: tSub.id, heavy: tHeavy.id });
        await setTierFallback({ main: null, sub: null, heavy: null });
        await setRoleTierOverrides({});

        // 移行が local entry を新規作成した場合に回収するため、前後の registry id を比較。
        const idsBefore = new Set((await listModels()).map((m) => m.id));
        const r = await migrateLocalRolesToTierOverrides();
        for (const m of await listModels()) {
          if (!idsBefore.has(m.id) && !createdIds.includes(m.id)) createdIds.push(m.id);
        }
        check(r.migrated === true, "local 使用環境 → migrated=true");

        const ov = await getRoleTierOverrides();
        const expectedRoles = [...local.roles, "notify"];
        check(
          expectedRoles.every((role) => typeof ov[role] === "string" && ov[role].length > 0),
          `全 local role + notify が role_tier_overrides に設定された (${expectedRoles.length} 件)`
        );
        // 全部同じ local entry id を指す
        const ids = new Set(expectedRoles.map((role) => ov[role]));
        check(ids.size === 1, "全 role が同一 local entry id を指す");

        const fb = await getTierFallback();
        check(fb.sub === tSub.id, "fallback.sub に hosted sub (assignment.sub) が設定された");

        check((await getAiSetting("model_local_roles_migrated")) === "1", "移行フラグが立った");

        // 冪等性: 2 回目は no-op
        const r2 = await migrateLocalRolesToTierOverrides();
        check(r2.migrated === false, "2 回目は migrated=false (冪等)");
      }
    }

    // ── 7. M5 移行 (intent/project_suggest を local に) ──
    console.log("[7] M5 移行 (migrateIntentRolesToLocal)");
    {
      const local = await getLocalLlmConfig();
      await updateAiSettings({ model_intent_roles_migrated: "" });
      if (!local.enabled || !local.url) {
        const r = await migrateIntentRolesToLocal();
        check(r.migrated === false, "local 未使用 → migrated=false");
        check((await getAiSetting("model_intent_roles_migrated")) === "1", "フラグは立つ");
      } else {
        await setTierAssignment({ main: tMain.id, sub: tSub.id, heavy: tHeavy.id });
        await setRoleTierOverrides({});
        const idsBefore = new Set((await listModels()).map((m) => m.id));
        const r = await migrateIntentRolesToLocal();
        for (const m of await listModels()) {
          if (!idsBefore.has(m.id) && !createdIds.includes(m.id)) createdIds.push(m.id);
        }
        check(r.migrated === true && r.roles === 2, "local 使用 → intent/project_suggest の 2 件を移行");
        const ov = await getRoleTierOverrides();
        check(typeof ov["intent"] === "string" && typeof ov["project_suggest"] === "string", "intent/project_suggest が role 上書きに入った");
        check(ov["intent"] === ov["project_suggest"], "両方が同一 local entry id を指す");
        const r2 = await migrateIntentRolesToLocal();
        check(r2.migrated === false, "2 回目は冪等 (migrated=false)");
      }
    }

    // ── summary ──
    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) {
      for (const f of failures) console.log(`  FAIL: ${f}`);
    }
  } finally {
    // ── restore (snapshot に戻す) ──
    await updateAiSettings({
      model_tier_assignment: snap.assignment ?? "",
      model_tier_fallback: snap.fallback ?? "",
      role_tier_overrides: snap.overrides ?? "",
      model_local_roles_migrated: snap.migrated ?? "",
      model_intent_roles_migrated: snap.intentMigrated ?? "",
    });
    for (const id of createdIds) await deleteModel(id).catch(() => {});
    console.log("[restore] ai_settings + temp entries を元に戻しました");
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
