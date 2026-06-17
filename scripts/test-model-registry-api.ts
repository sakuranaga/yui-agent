/**
 * #206 M4 API + ゲートの検証。
 * Usage (container 内): npx tsx scripts/test-model-registry-api.ts
 *
 * - 純粋関数: sanitizeLocalBaseUrl / validateTierGate / findEntryReferences
 * - route ハンドラ: create / PUT tiers (422 ゲート) / DELETE (409 ガード) / PATCH (capabilities reset + 409)
 *
 * 実 DB の tier KV を snapshot → finally restore、temp entry は削除。
 */
import type { NextRequest } from "next/server";
import { sanitizeLocalBaseUrl, listModels, deleteModel, createModel, setRoleTierOverrides } from "@/lib/model-registry";
import { checkToolSlots, roleRequiresTool, findEntryReferences, type TierSlot } from "@/lib/model-tier-gate";
import type { ModelEntry } from "@/lib/model-registry";
import { getAiSetting, updateAiSettings } from "@/lib/ai-settings";
import { POST as createModelRoute } from "@/app/api/model-registry/route";
import { PATCH as patchModelRoute, DELETE as deleteModelRoute } from "@/app/api/model-registry/[id]/route";
import { PUT as putTiersRoute } from "@/app/api/model-registry/tiers/route";

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

function jsonReq(method: string, body: unknown): NextRequest {
  return new Request("http://x/api/model-registry", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}
function entry(id: string, supportsTools: boolean | undefined): ModelEntry {
  return {
    id, label: id, provider: "anthropic", modelId: "m", baseUrl: null, apiKeyRef: "anthropic",
    capabilities: supportsTools === undefined ? {} : { supportsTools, reachable: true },
    thinkingMode: "auto",
    maxTokens: 8192,
  };
}

async function main() {
  const snap = {
    assignment: await getAiSetting("model_tier_assignment"),
    fallback: await getAiSetting("model_tier_fallback"),
    overrides: await getAiSetting("role_tier_overrides"),
  };
  const createdIds: string[] = [];

  try {
    // ── 1. sanitizeLocalBaseUrl ──
    console.log("[1] sanitizeLocalBaseUrl");
    {
      const a = sanitizeLocalBaseUrl("http://100.81.60.55:8000/v1/chat/completions");
      check(a.ok && a.value === "http://100.81.60.55:8000/v1", "CGNAT 許可 + /chat/completions 除去");
      const b = sanitizeLocalBaseUrl("http://llm:8081/v1");
      check(b.ok && b.value === "http://llm:8081/v1", "docker 内部ホスト許可");
      check(!sanitizeLocalBaseUrl("ftp://x/v1").ok, "ftp は拒否");
      check(!sanitizeLocalBaseUrl("http://u:p@host/v1").ok, "認証情報付きは拒否");
      check(!sanitizeLocalBaseUrl("notaurl").ok, "不正 URL は拒否");
      const c = sanitizeLocalBaseUrl("http://h:9/v1?x=1#f");
      check(c.ok && c.value === "http://h:9/v1", "search/hash 除去");
    }

    // ── 2. checkToolSlots / roleRequiresTool ──
    console.log("[2] checkToolSlots / roleRequiresTool");
    {
      const byId = new Map<string, ModelEntry>([
        ["tool", entry("tool", true)],
        ["notool", entry("notool", false)],
        ["untested", entry("untested", undefined)],
      ]);
      const slot = (entryId: string | null, requiresTool: boolean): TierSlot => ({ label: "s", entryId, requiresTool });
      check(checkToolSlots([slot("tool", true)], byId).length === 0, "tool entry を tool 必須枠 → OK");
      check(checkToolSlots([slot("notool", true)], byId).length === 1, "非 tool を tool 必須枠 → 違反");
      check(checkToolSlots([slot("untested", true)], byId).length === 1, "未テストを tool 必須枠 → 違反");
      check(checkToolSlots([slot("notool", false)], byId).length === 0, "非 tool を tool 不要枠 (sub) → OK");
      check(checkToolSlots([slot(null, true)], byId).length === 0, "null スロットは無視");
      check(roleRequiresTool("specialist") === true, "specialist は tool 必須 (heavy)");
      check(roleRequiresTool("judge") === false, "judge は tool 不要 (sub)");
      check(roleRequiresTool("main") === true, "main は tool 必須");
    }

    // ── 3. findEntryReferences ──
    console.log("[3] findEntryReferences");
    {
      const refs = findEntryReferences(
        "X",
        { main: "X", sub: null, heavy: null } as never,
        { main: null, sub: "X", heavy: null } as never,
        { judge: "X", diary: "main" } as never
      );
      // assignment.main / fallback.sub / roleOverride.judge(直) / roleOverride.diary→main(間接、assignment.main=X) の 4 件
      check(refs.length === 4, "直参照 3 + tier 名経由の間接 role 上書き 1 = 4 件検出");
      check(findEntryReferences("Y", { main: "X", sub: null, heavy: null } as never, { main: null, sub: null, heavy: null } as never, {} as never).length === 0, "無関係 id は 0 件");
    }

    // ── 4. route: create (local 正常 / 不正 / hosted) ──
    console.log("[4] POST /api/model-registry");
    let localId = "";
    {
      const res = await createModelRoute(jsonReq("POST", { label: "L", provider: "local_openai", modelId: "gemma", baseUrl: "http://10.0.0.5:8000/v1/chat/completions" }));
      const body = (await res.json()) as { entry?: ModelEntry; error?: string };
      check(res.status === 201 && body.entry?.baseUrl === "http://10.0.0.5:8000/v1", "local 作成 201 + base 正規化");
      if (body.entry) { localId = body.entry.id; createdIds.push(localId); }

      const bad = await createModelRoute(jsonReq("POST", { label: "L", provider: "local_openai", modelId: "g", baseUrl: "ftp://x" }));
      check(bad.status === 400, "local 不正 base → 400");

      const noBase = await createModelRoute(jsonReq("POST", { label: "L", provider: "local_openai", modelId: "g" }));
      check(noBase.status === 400, "local base 無し → 400");

      const hosted = await createModelRoute(jsonReq("POST", { label: "H", provider: "anthropic", modelId: "claude-haiku-4-5" }));
      const hb = (await hosted.json()) as { entry?: ModelEntry };
      check(hosted.status === 201, "hosted 作成 201");
      if (hb.entry) createdIds.push(hb.entry.id);
    }

    // ── 5. route: PUT /tiers ゲート (422) ──
    console.log("[5] PUT /api/model-registry/tiers ゲート");
    {
      // localId は capabilities 未設定 (未テスト) → main 割当は 422 になるはず
      const res = await putTiersRoute(jsonReq("PUT", { assignment: { main: localId } }));
      check(res.status === 422, "未テスト local を main → 422");
      const body = (await res.json()) as { violations?: unknown[] };
      check(Array.isArray(body.violations) && body.violations.length > 0, "violations を返す");

      // sub 割当は OK (tool 不問)
      const ok = await putTiersRoute(jsonReq("PUT", { assignment: { sub: localId } }));
      check(ok.status === 200, "未テスト local を sub → 200");

      // sub role に未テスト local を entry-id 直指定 → tool 不問 → 200
      const subOv = await putTiersRoute(jsonReq("PUT", { roleOverrides: { judge: localId } }));
      check(subOv.status === 200, "judge(sub) に未テスト local を直指定 → 200");

      // 不正値 (実在しない entry id) → 400 (中-1)
      const badVal = await putTiersRoute(jsonReq("PUT", { roleOverrides: { judge: "nonexistent-id" } }));
      check(badVal.status === 400, "実在しない entry id の role 上書き → 400");

      // 未知 role キー → 400
      const badRole = await putTiersRoute(jsonReq("PUT", { roleOverrides: { bogus_role: localId } }));
      check(badRole.status === 400, "未知 role キー → 400");
    }

    // ── 6. route: DELETE ガード (409) ──
    console.log("[6] DELETE ガード");
    {
      // localId は今 sub に割当中 (前テスト) → 削除は 409
      const res = await deleteModelRoute(jsonReq("DELETE", {}), { params: Promise.resolve({ id: localId }) });
      check(res.status === 409, "割当中の削除 → 409");
      const body = (await res.json()) as { references?: string[] };
      check(Array.isArray(body.references) && body.references.length > 0, "references を返す");
    }

    // ── 7. route: PATCH capabilities reset + 409 ──
    console.log("[7] PATCH capabilities reset / 409");
    {
      // 未参照 entry を作って modelId 変更 → capabilities リセット
      const created = await createModelRoute(jsonReq("POST", { label: "P", provider: "local_openai", modelId: "old", baseUrl: "http://10.0.0.9:8000/v1" }));
      const cb = (await created.json()) as { entry: ModelEntry };
      createdIds.push(cb.entry.id);
      const res = await patchModelRoute(jsonReq("PATCH", { modelId: "new" }), { params: Promise.resolve({ id: cb.entry.id }) });
      const pb = (await res.json()) as { entry?: ModelEntry };
      check(res.status === 200 && pb.entry?.modelId === "new", "modelId 変更 200");
      check(pb.entry !== undefined && pb.entry.capabilities.supportsTools === undefined, "capabilities がリセットされた");

      // localId は sub 割当中 (tool 不要) なので modelId 変更は許可される (409 にならない)
      const subPatch = await patchModelRoute(jsonReq("PATCH", { modelId: "gemma2" }), { params: Promise.resolve({ id: localId }) });
      check(subPatch.status === 200, "sub 参照のみの entry は modelId 変更可 (409 にならない)");
    }

    // ── 8. role 上書きは entry id のみ + heavy role の entry-id ゲート ──
    console.log("[8] role 上書きの値制限 + heavy role ゲート");
    {
      await setRoleTierOverrides({});
      // tier 名指定は API では拒否 (entry id のみ)。
      const tierName = await putTiersRoute(jsonReq("PUT", { roleOverrides: { main: "sub" } }));
      check(tierName.status === 400, "role 上書きに tier 名 → 400 (entry id のみ)");

      // 未テスト local を作り specialist (heavy role) に entry-id 直指定 → tool 必須 → 422
      const ut = await createModel({ label: "ut8", provider: "local_openai", modelId: "g", baseUrl: "http://10.0.0.8:8000/v1" });
      createdIds.push(ut.id);
      const heavyOv = await putTiersRoute(jsonReq("PUT", { roleOverrides: { specialist: ut.id } }));
      check(heavyOv.status === 422, "specialist(heavy) に未テスト entry を直指定 → 422");

      // 同じ未テスト entry を judge (sub role) に直指定 → tool 不問 → 200
      const subOv2 = await putTiersRoute(jsonReq("PUT", { roleOverrides: { judge: ut.id } }));
      check(subOv2.status === 200, "judge(sub) に未テスト entry を直指定 → 200");
    }

    // ── 9. thinkingMode PATCH (§8.9) ──
    console.log("[9] thinkingMode PATCH");
    {
      const loc = await createModel({ label: "tm-local", provider: "local_openai", modelId: "g", baseUrl: "http://10.0.0.20:8000/v1" });
      createdIds.push(loc.id);
      const ok = await patchModelRoute(jsonReq("PATCH", { thinkingMode: "off" }), { params: Promise.resolve({ id: loc.id }) });
      const okb = (await ok.json()) as { entry?: ModelEntry };
      check(ok.status === 200 && okb.entry?.thinkingMode === "off", "local の thinkingMode off → 保存");

      const bad = await patchModelRoute(jsonReq("PATCH", { thinkingMode: "weird" }), { params: Promise.resolve({ id: loc.id }) });
      check(bad.status === 400, "不正な thinkingMode → 400");

      // hosted は thinkingMode を無視 (auto のまま)
      const hosted = await createModel({ label: "tm-hosted", provider: "anthropic", modelId: "claude-haiku-4-5", apiKeyRef: "anthropic" });
      createdIds.push(hosted.id);
      const hr = await patchModelRoute(jsonReq("PATCH", { thinkingMode: "off" }), { params: Promise.resolve({ id: hosted.id }) });
      const hb = (await hr.json()) as { entry?: ModelEntry };
      check(hr.status === 200 && hb.entry?.thinkingMode === "auto", "hosted の thinkingMode は無視 (auto のまま)");

      // maxTokens PATCH (§8.10)
      const mtOk = await patchModelRoute(jsonReq("PATCH", { maxTokens: 32768 }), { params: Promise.resolve({ id: loc.id }) });
      const mtb = (await mtOk.json()) as { entry?: ModelEntry };
      check(mtOk.status === 200 && mtb.entry?.maxTokens === 32768, "maxTokens 32768 → 保存");
      const mtBad = await patchModelRoute(jsonReq("PATCH", { maxTokens: 0 }), { params: Promise.resolve({ id: loc.id }) });
      check(mtBad.status === 400, "maxTokens 0 → 400");
      const mtBad2 = await patchModelRoute(jsonReq("PATCH", { maxTokens: 2000000 }), { params: Promise.resolve({ id: loc.id }) });
      check(mtBad2.status === 400, "maxTokens 上限超過 → 400");
      const mtBad3 = await patchModelRoute(jsonReq("PATCH", { maxTokens: 1.5 }), { params: Promise.resolve({ id: loc.id }) });
      check(mtBad3.status === 400, "maxTokens 非整数 → 400");
    }

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length > 0) for (const f of failures) console.log(`  FAIL: ${f}`);
  } finally {
    await updateAiSettings({
      model_tier_assignment: snap.assignment ?? "",
      model_tier_fallback: snap.fallback ?? "",
      role_tier_overrides: snap.overrides ?? "",
    });
    // temp entry + 念のため leak した entry を回収
    for (const id of createdIds) await deleteModel(id).catch(() => {});
    void listModels; // (lint: 使用明示)
    console.log("[restore] tier KV + temp entries を元に戻しました");
  }

  process.exit(failures.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
