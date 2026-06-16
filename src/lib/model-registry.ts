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
import { modelRegistry, aiSettings, type ModelCapabilities } from "@/db/schema";
import { eq, sql } from "drizzle-orm";
import {
  getAiSetting,
  updateAiSettings,
  getAnthropicConfig,
  getLocalLlmConfig,
  invalidateCache,
} from "@/lib/ai-settings";
import { detectProvider } from "@/lib/llm-providers/detect";

export type ModelProvider = "anthropic" | "openai" | "gemini" | "grok" | "local_openai";
export type TierName = "main" | "sub" | "heavy";

export type ModelEntry = {
  id: string;
  label: string;
  provider: ModelProvider;
  modelId: string;
  baseUrl: string | null;
  apiKeyRef: string | null;
  capabilities: ModelCapabilities;
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
  }>
): Promise<ModelEntry | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.label !== undefined) set.label = patch.label.trim();
  if (patch.provider !== undefined) set.provider = patch.provider;
  if (patch.modelId !== undefined) set.modelId = patch.modelId.trim();
  if (patch.baseUrl !== undefined) set.baseUrl = patch.baseUrl;
  if (patch.apiKeyRef !== undefined) set.apiKeyRef = patch.apiKeyRef;
  if (patch.capabilities !== undefined) set.capabilities = patch.capabilities;
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

const EMPTY_ASSIGNMENT: TierAssignment = { main: null, sub: null, heavy: null };

function parseTierJson(raw: string | null): TierAssignment {
  if (!raw || !raw.trim()) return { ...EMPTY_ASSIGNMENT };
  try {
    const o = JSON.parse(raw) as Partial<TierAssignment>;
    return { main: o.main ?? null, sub: o.sub ?? null, heavy: o.heavy ?? null };
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

// ───── 移行 seed ─────

/** OpenAI 互換 endpoint の full URL から base (.../v1) を取り出す (二重 suffix 防止)。 */
export function normalizeOpenAiBase(url: string): string {
  const trimmed = url.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/chat\/completions$/i, "");
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
    const assignment = JSON.stringify({ main: mainId, sub: subId, heavy: subId });
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
