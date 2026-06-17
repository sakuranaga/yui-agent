/**
 * モデルレジストリ (docs/model-config-overhaul.md #206 M1)。
 *
 * - hosted / ローカルの LLM を複数登録 (provider 明示)。
 * - 3 tier (main/sub/heavy) への割当・fallback は ai_settings KV に JSON で保存。
 * - 既存設定 (anthropic_main_model / haiku_model / local_llm_*) からの移行 seed。
 *
 * M1 はレジストリ + 割当 + 移行のみ。callLlm の resolve 刷新は M3、能力テストは M2。
 */
import { randomUUID } from "node:crypto";
import { db } from "@/db/client";
import { modelRegistry, aiSettings, type ModelCapabilities, type ThinkingMode } from "@/db/schema";
import { and, eq, sql } from "drizzle-orm";
import {
  getAiSetting,
  updateAiSettings,
  getAnthropicConfig,
  getLocalLlmConfig,
  invalidateCache,
  type AiSettingKey,
} from "@/lib/ai-settings";
import { detectProvider } from "@/lib/llm-providers/detect";

export type ModelProvider = "anthropic" | "openai" | "gemini" | "grok" | "local_openai";
// "tool" = ツール選択専用 tier (Executor #2)。xLAM 等の function-calling 専用モデルを割当。
export type TierName = "main" | "sub" | "heavy" | "tool";

export type ModelEntry = {
  id: string;
  label: string;
  provider: ModelProvider;
  modelId: string;
  baseUrl: string | null;
  apiKeyRef: string | null;
  capabilities: ModelCapabilities;
  thinkingMode: ThinkingMode;
  maxTokens: number;
};

export type TierAssignment = Record<TierName, string | null>;
export type TierFallback = Record<TierName, string | null>;

function rowToEntry(r: typeof modelRegistry.$inferSelect): ModelEntry {
  return {
    id: r.id,
    label: r.label,
    provider: r.provider as ModelProvider,
    modelId: r.modelId,
    baseUrl: r.baseUrl,
    apiKeyRef: r.apiKeyRef,
    capabilities: r.capabilities ?? {},
    thinkingMode: r.thinkingMode ?? "auto",
    maxTokens: r.maxTokens ?? 8192,
  };
}

// ───── CRUD ─────

export async function listModels(): Promise<ModelEntry[]> {
  const rows = await db.select().from(modelRegistry).orderBy(modelRegistry.createdAt);
  return rows.map(rowToEntry);
}

export async function getModel(id: string): Promise<ModelEntry | null> {
  const [row] = await db.select().from(modelRegistry).where(eq(modelRegistry.id, id)).limit(1);
  return row ? rowToEntry(row) : null;
}

export async function createModel(input: {
  label: string;
  provider: ModelProvider;
  modelId: string;
  baseUrl?: string | null;
  apiKeyRef?: string | null;
  capabilities?: ModelCapabilities;
  thinkingMode?: ThinkingMode;
  maxTokens?: number;
}): Promise<ModelEntry> {
  const id = randomUUID();
  const [row] = await db
    .insert(modelRegistry)
    .values({
      id,
      label: input.label.trim(),
      provider: input.provider,
      modelId: input.modelId.trim(),
      baseUrl: input.baseUrl ?? null,
      apiKeyRef: input.apiKeyRef ?? null,
      capabilities: input.capabilities ?? {},
      thinkingMode: input.thinkingMode ?? "auto",
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
    })
    .returning();
  return rowToEntry(row);
}

export async function updateModel(
  id: string,
  patch: Partial<{
    label: string;
    provider: ModelProvider;
    modelId: string;
    baseUrl: string | null;
    apiKeyRef: string | null;
    capabilities: ModelCapabilities;
    thinkingMode: ThinkingMode;
    maxTokens: number;
  }>
): Promise<ModelEntry | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.label !== undefined) set.label = patch.label.trim();
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.modelId !== undefined) set.modelId = patch.modelId.trim();
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
  if (patch.apiKeyRef !== undefined) set.apiKeyRef = patch.apiKeyRef;
  if (patch.capabilities !== undefined) set.capabilities = patch.capabilities;
  if (patch.thinkingMode !== undefined) set.thinkingMode = patch.thinkingMode;
  if (patch.maxTokens !== undefined) set.maxTokens = patch.maxTokens;
  const [row] = await db
    .update(modelRegistry)
    .set(set)
    .where(eq(modelRegistry.id, id))
    .returning();
  return row ? rowToEntry(row) : null;
}

/** モデル削除。tier に割り当て中なら呼び側で弾く想定 (M4 UI でガード)。 */
export async function deleteModel(id: string): Promise<boolean> {
  const rows = await db.delete(modelRegistry).where(eq(modelRegistry.id, id)).returning();
  return rows.length > 0;
}

// ───── tier 割当 / fallback (ai_settings KV) ─────

const EMPTY_ASSIGNMENT: TierAssignment = { main: null, sub: null, heavy: null, tool: null };

function parseTierJson(raw: string | null): TierAssignment {
  if (!raw || !raw.trim()) return { ...EMPTY_ASSIGNMENT };
  try {
    const o = JSON.parse(raw) as Partial<TierAssignment>;
    // tool は後付け tier なので既存データ (main/sub/heavy のみ) では null = executor role が
    // sub fallback / 防御 ephemeral へ倒れる (= 設定で割り当てるまで安全に動く)。
    return { main: o.main ?? null, sub: o.sub ?? null, heavy: o.heavy ?? null, tool: o.tool ?? null };
  } catch {
    return { ...EMPTY_ASSIGNMENT };
  }
}

export async function getTierAssignment(): Promise<TierAssignment> {
  return parseTierJson(await getAiSetting("model_tier_assignment"));
}
export async function setTierAssignment(a: TierAssignment): Promise<void> {
  await updateAiSettings({ model_tier_assignment: JSON.stringify(a) });
}
export async function getTierFallback(): Promise<TierFallback> {
  return parseTierJson(await getAiSetting("model_tier_fallback"));
}
export async function setTierFallback(f: TierFallback): Promise<void> {
  await updateAiSettings({ model_tier_fallback: JSON.stringify(f) });
}

// ───── role → tier|entryId 上書き (ai_settings KV) ─────

/** role → (tier 名 "main|sub|heavy" or model entry id) の上書きマップ。 */
export type RoleTierOverrides = Record<string, string>;

function parseRoleOverrides(raw: string | null): RoleTierOverrides {
  if (!raw || !raw.trim()) return {};
  try {
    const o = JSON.parse(raw) as unknown;
    if (o && typeof o === "object" && !Array.isArray(o)) {
      const out: RoleTierOverrides = {};
      for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
        if (typeof v === "string" && v.trim()) out[k] = v;
      }
      return out;
    }
  } catch {
    /* ignore */
  }
  return {};
}

export async function getRoleTierOverrides(): Promise<RoleTierOverrides> {
  return parseRoleOverrides(await getAiSetting("role_tier_overrides"));
}
export async function setRoleTierOverrides(o: RoleTierOverrides): Promise<void> {
  await updateAiSettings({ role_tier_overrides: JSON.stringify(o) });
}

// ───── 移行 seed ─────

/** OpenAI 互換 endpoint の full URL から base (.../v1) を取り出す (二重 suffix 防止)。 */
export function normalizeOpenAiBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/chat\/completions$/i, "");
}

/**
 * local_openai の base_url 軽量検証 (#206 §8.6.1)。
 * SSRF 用 validatePublicUrl は使わない (private/CGNAT を弾きローカル endpoint を拒否するため)。
 * http/https・hostname 必須・認証情報禁止・hash/search 除去 → normalizeOpenAiBase。
 */
export function sanitizeLocalBaseUrl(
  raw: string
): { ok: true; value: string } | { ok: false; error: string } {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return { ok: false, error: "URL の形式が不正です" };
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return { ok: false, error: "http:// または https:// のみ対応です" };
  }
  if (!u.hostname) return { ok: false, error: "ホスト名がありません" };
  if (u.username || u.password) return { ok: false, error: "URL に認証情報は含められません" };
  u.hash = "";
  u.search = "";
  return { ok: true, value: normalizeOpenAiBase(u.toString()) };
}

/** maxTokens の検証 (1..1048576 の正整数)。DB CHECK と揃える (#206 §8.10)。 */
export function validateMaxTokens(
  v: unknown
): { ok: true; value: number } | { ok: false; error: string } {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1 || v > 1048576) {
    return { ok: false, error: "最大トークンは 1〜1048576 の整数です" };
  }
  return { ok: true, value: v };
}

/** provider → api_key_ref (= 暗号化済キーの参照名)。local は null。 */
function apiKeyRefFor(provider: ModelProvider): string | null {
  return provider === "local_openai" ? null : provider;
}

// 移行 seed を直列化する advisory lock のキー (#206 専用の任意定数)。
const SEED_LOCK_KEY = 206206;

/**
 * レジストリが空の時だけ、既存設定から entry を seed して tier を割り当てる (= 移行)。
 * - main_model → main、haiku_model → sub、**heavy = sub と同じ entry** (挙動保存)。
 * - local 有効なら local_openai entry も作る (base_url 正規化)。自動割当はしない。
 *
 * **原子性 + 並行安全 (Codex M1 指摘 #1/#2)**: entry 作成 + tier 割当を 1 transaction に入れ、
 * xact-scoped advisory lock で並行 seeder を直列化する。部分失敗で「entry はあるが割当が空」
 * という壊れた状態に固定されるのを防ぎ、複数プロセス起動時の二重作成も防ぐ。
 */
export async function seedModelRegistryIfEmpty(): Promise<{ seeded: number }> {
  const [anth, local] = await Promise.all([getAnthropicConfig(), getLocalLlmConfig()]);

  const result = await db.transaction(async (tx) => {
    // 並行 seeder を直列化 (= 先行が commit したら後続は非空を見て skip)
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${SEED_LOCK_KEY})`);

    const existing = await tx.select({ id: modelRegistry.id }).from(modelRegistry).limit(1);
    if (existing.length > 0) return { seeded: 0 };

    const mainProvider = detectProvider(anth.mainModel) as ModelProvider;
    const subProvider = detectProvider(anth.haikuModel) as ModelProvider;
    const mainId = randomUUID();
    const subId = randomUUID();

    const values: (typeof modelRegistry.$inferInsert)[] = [
      {
        id: mainId,
        label: `${anth.mainModel} (main)`,
        provider: mainProvider,
        modelId: anth.mainModel,
        apiKeyRef: apiKeyRefFor(mainProvider),
      },
      {
        id: subId,
        label: `${anth.haikuModel} (sub)`,
        provider: subProvider,
        modelId: anth.haikuModel,
        apiKeyRef: apiKeyRefFor(subProvider),
      },
    ];
    if (local.enabled && local.url) {
      values.push({
        id: randomUUID(),
        label: `${local.model} (local)`,
        provider: "local_openai",
        modelId: local.model,
        baseUrl: normalizeOpenAiBase(local.url),
        apiKeyRef: null,
      });
    }
    await tx.insert(modelRegistry).values(values);

    // tier 割当: heavy=sub (= 現 specialist は Haiku 解決なので挙動保存)。同 tx で ai_settings upsert。
    // tool = sub と同じ entry を既定 (= ネイティブ tool-use 可能な Haiku。後で設定で xLAM 等に変更)。
    const assignment = JSON.stringify({ main: mainId, sub: subId, heavy: subId, tool: subId });
    await tx
      .insert(aiSettings)
      .values({ key: "model_tier_assignment", value: assignment, isSecret: false, updatedAt: new Date() })
      .onConflictDoUpdate({
        target: aiSettings.key,
        set: { value: assignment, isSecret: false, updatedAt: new Date() },
      });

    return { seeded: values.length };
  });

  // tx 内で ai_settings を raw insert したので、commit 後に ai-settings キャッシュを無効化
  // (= updateAiSettings 非経由のため自動 invalidate が走らない。readers が stale を見ない様に)。
  if (result.seeded > 0) await invalidateCache();
  return result;
}

// local-roles 移行を直列化する advisory lock のキー (#206 M3 専用)。
const LOCAL_ROLES_LOCK_KEY = 206207;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** tx 内で ai_settings の生 value を読む (未存在は null)。 */
async function readSettingTx(tx: Tx, key: AiSettingKey): Promise<string | null> {
  const [row] = await tx
    .select({ value: aiSettings.value })
    .from(aiSettings)
    .where(eq(aiSettings.key, key))
    .limit(1);
  return row?.value ?? null;
}

/** tx 内で ai_settings を upsert。 */
async function upsertSettingTx(tx: Tx, key: AiSettingKey, value: string): Promise<void> {
  await tx
    .insert(aiSettings)
    .values({ key, value, isSecret: false, updatedAt: new Date() })
    .onConflictDoUpdate({ target: aiSettings.key, set: { value, isSecret: false, updatedAt: new Date() } });
}

/** local entry を (provider + modelId + 正規化 base で) 同定し、無ければ作って id を返す。 */
async function findOrCreateLocalEntryTx(tx: Tx, local: { model: string; url: string }): Promise<string> {
  const normBase = normalizeOpenAiBase(local.url);
  const found = await tx
    .select()
    .from(modelRegistry)
    .where(
      and(
        eq(modelRegistry.provider, "local_openai"),
        eq(modelRegistry.modelId, local.model),
        eq(modelRegistry.baseUrl, normBase)
      )
    )
    .limit(1);
  if (found.length > 0) return found[0].id;
  const id = randomUUID();
  await tx.insert(modelRegistry).values({
    id,
    label: `${local.model} (local)`,
    provider: "local_openai",
    modelId: local.model,
    baseUrl: normBase,
    apiKeyRef: null,
  });
  return id;
}

/** local 失敗時の hosted fallback 保存: model_tier_fallback.sub 未設定なら assignment.sub を入れる。 */
async function ensureSubFallbackTx(tx: Tx): Promise<void> {
  const fallback = parseTierJson(await readSettingTx(tx, "model_tier_fallback"));
  if (!fallback.sub) {
    const assignment = parseTierJson(await readSettingTx(tx, "model_tier_assignment"));
    if (assignment.sub) {
      fallback.sub = assignment.sub;
      await upsertSettingTx(tx, "model_tier_fallback", JSON.stringify(fallback));
    }
  }
}

/**
 * M3 移行 (一度だけ): 旧 `local_llm_roles`(+`notify`) の per-role local routing を
 * `role_tier_overrides[role] = <local entry id>` に変換し、現挙動を保存する。
 * (設計: docs/model-config-overhaul.md §8.5.1)
 *
 * - seed とは別経路。M1 seed 済みの既存環境でも確実に走る。
 * - `model_local_roles_migrated` フラグで冪等 (一度だけ。後でユーザーが override を消しても再付与しない)。
 * - local entry が無ければ作る (M1 seed 後に local を有効化した環境を救う)。
 * - `model_tier_fallback.sub` 未設定なら hosted sub を設定 (local 失敗時の hosted fallback 保存)。
 * - advisory lock + tx + flag 再確認で並行・部分失敗に安全。
 */
export async function migrateLocalRolesToTierOverrides(): Promise<{ migrated: boolean; roles: number }> {
  const local = await getLocalLlmConfig();

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${LOCAL_ROLES_LOCK_KEY})`);

    // 並行プロセス対策: ロック取得後に flag を再確認 (先行が commit 済なら skip)。
    const flag = await readSettingTx(tx, "model_local_roles_migrated");
    if (flag === "1") return { migrated: false, roles: 0 };

    // local 不使用環境 → 何も移行せずフラグだけ立てる。
    if (!local.enabled || !local.url) {
      await upsertSettingTx(tx, "model_local_roles_migrated", "1");
      return { migrated: false, roles: 0 };
    }

    const localId = await findOrCreateLocalEntryTx(tx, local);

    // 旧 local_llm_roles + 常時 local の "notify" を per-role override に変換 (未設定の role のみ)。
    const roles = new Set<string>([...local.roles, "notify"]);
    const overrides = parseRoleOverrides(await readSettingTx(tx, "role_tier_overrides"));
    let added = 0;
    for (const role of roles) {
      if (!overrides[role]) {
        overrides[role] = localId;
        added++;
      }
    }
    await upsertSettingTx(tx, "role_tier_overrides", JSON.stringify(overrides));
    await ensureSubFallbackTx(tx);

    await upsertSettingTx(tx, "model_local_roles_migrated", "1");
    return { migrated: true, roles: added };
  });

  // tx 内で ai_settings を raw upsert したので commit 後にキャッシュ無効化。
  await invalidateCache();
  return result;
}

// M5 移行を直列化する advisory lock のキー (#206 M5 専用)。
const INTENT_ROLES_LOCK_KEY = 206208;

/**
 * M5 移行 (一度だけ): 旧 callLocalLlm 直叩きだった `intent` / `project_suggest` を、
 * local entry への role 上書きに変換し「local 常時」挙動を保存する (設計 §8.7.1)。
 * local 有効環境のみ。local entry は find-or-create、fallback.sub も冪等に確保。
 */
export async function migrateIntentRolesToLocal(): Promise<{ migrated: boolean; roles: number }> {
  const local = await getLocalLlmConfig();

  const result = await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${INTENT_ROLES_LOCK_KEY})`);

    const flag = await readSettingTx(tx, "model_intent_roles_migrated");
    if (flag === "1") return { migrated: false, roles: 0 };

    if (!local.enabled || !local.url) {
      await upsertSettingTx(tx, "model_intent_roles_migrated", "1");
      return { migrated: false, roles: 0 };
    }

    const localId = await findOrCreateLocalEntryTx(tx, local);
    const overrides = parseRoleOverrides(await readSettingTx(tx, "role_tier_overrides"));
    let added = 0;
    for (const role of ["intent", "project_suggest"]) {
      if (!overrides[role]) {
        overrides[role] = localId;
        added++;
      }
    }
    await upsertSettingTx(tx, "role_tier_overrides", JSON.stringify(overrides));
    await ensureSubFallbackTx(tx);

    await upsertSettingTx(tx, "model_intent_roles_migrated", "1");
    return { migrated: true, roles: added };
  });

  await invalidateCache();
  return result;
}
