/**
 * AI 関連設定の DB アクセス層 + 30s キャッシュ + 型付き helper。
 *
 * 取得は DB → env → ハードコードデフォルトの順にフォールバック。
 * caller は本ファイルの型付き helper (getAnthropicConfig 等) を使う。
 *
 * 設計: docs/ai-settings.md
 */
import { db } from "@/db/client";
import { aiSettings } from "@/db/schema";
import { inArray } from "drizzle-orm";

// --- key 定義 (UI / API でも使う) ---

export type AiSettingKey =
  // Anthropic
  | "anthropic_api_key"
  | "anthropic_main_model"   // 「メインモデル」(Yui 本体)。Anthropic に限らず任意プロバイダの model ID を保存。命名は legacy
  | "anthropic_haiku_model"  // 「サブモデル」(要約・分類等の軽 LLM タスク)。同上、legacy 名
  // 他 provider API key (Phase 2 で router がこれを参照して SDK 振り分け)
  | "openai_api_key"
  | "gemini_api_key"
  | "grok_api_key"
  // Local LLM (OpenAI 互換、Gemma / LFM 等)
  | "local_llm_enabled"
  | "local_llm_url"
  | "local_llm_model"
  // どの内部 role でローカル LLM を使うかをカンマ区切りで指定。
  // 例: "extract,reconcile,judge,tts_normalize"
  // 空文字なら 1 つも使わない (全 role が Anthropic 経由)。
  | "local_llm_roles"
  // モデル設定刷新 (#206): 3 tier 割当 / fallback / role→tier override を JSON で保存
  | "model_tier_assignment"  // {"main":"<entryId>","sub":"...","heavy":"..."}
  | "model_tier_fallback"    // {"main":"<entryId|null>","sub":...,"heavy":...}
  | "role_tier_overrides"    // {"<role>":"main|sub|heavy"} (既定マップの上書き、任意)
  // TTS
  | "tts_url"
  | "tts_normal_ref"
  | "tts_whisper_ref"
  // Embeddings
  | "embed_url"
  | "embed_model"
  | "embed_dimensions";

/** どの key がシークレットか (マスク表示 + 更新時の "***" スキップ判定) */
export const SECRET_KEYS: ReadonlySet<AiSettingKey> = new Set<AiSettingKey>([
  "anthropic_api_key",
  "openai_api_key",
  "gemini_api_key",
  "grok_api_key",
]);

/** 各 key の env フォールバック名とハードコードデフォルト */
type Spec = {
  env: string | null;
  default: string | null;
};
const SPECS: Record<AiSettingKey, Spec> = {
  anthropic_api_key:     { env: "ANTHROPIC_API_KEY",       default: null },
  anthropic_main_model:  { env: "ANTHROPIC_MODEL",          default: "claude-sonnet-4-6" },
  anthropic_haiku_model: { env: "ANTHROPIC_HAIKU_MODEL",    default: "claude-haiku-4-5" },
  openai_api_key:        { env: "OPENAI_API_KEY",           default: null },
  gemini_api_key:        { env: "GEMINI_API_KEY",           default: null },
  grok_api_key:          { env: "GROK_API_KEY",             default: null },
  local_llm_enabled:     { env: "LOCAL_LLM_ENABLED",        default: "false" },
  local_llm_url:         { env: "LOCAL_LLM_URL",            default: "http://llm:8081/v1/chat/completions" },
  local_llm_model:       { env: "LOCAL_LLM_MODEL",          default: "gemma-4-26b-a4b" },
  local_llm_roles:       { env: "LOCAL_LLM_ROLES",          default: "" },
  model_tier_assignment: { env: "MODEL_TIER_ASSIGNMENT",    default: "" },
  model_tier_fallback:   { env: "MODEL_TIER_FALLBACK",      default: "" },
  role_tier_overrides:   { env: "ROLE_TIER_OVERRIDES",      default: "" },
  tts_url:               { env: "TTS_URL",                  default: null },
  tts_normal_ref:        { env: "TTS_NORMAL_REF",            default: null },
  tts_whisper_ref:       { env: "TTS_WHISPER_REF",           default: null },
  embed_url:             { env: "EMBED_URL",                default: "http://llm:8082/v1/embeddings" },
  embed_model:           { env: "EMBED_MODEL",              default: "bge-m3" },
  embed_dimensions:      { env: "EMBED_DIMENSIONS",         default: "1024" },
};

// --- キャッシュ (Valkey、プロセス間 / 再起動を跨いで共有) ---
import { cacheGet, cacheSet, cacheDel } from "@/lib/cache";

const CACHE_KEY = "ai-settings:all";
const CACHE_TTL_SEC = 30;

async function loadAllFromDb(): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  try {
    const rows = await db.select().from(aiSettings);
    for (const r of rows) out[r.key] = r.value;
  } catch (e) {
    console.warn("[ai-settings] DB load failed, using env/defaults:", e);
  }
  return out;
}

async function ensureCache(): Promise<Map<string, string | null>> {
  const hit = await cacheGet<Record<string, string | null>>(CACHE_KEY);
  if (hit) return new Map(Object.entries(hit));
  const fresh = await loadAllFromDb();
  await cacheSet(CACHE_KEY, fresh, CACHE_TTL_SEC);
  return new Map(Object.entries(fresh));
}

export async function invalidateCache(): Promise<void> {
  await cacheDel(CACHE_KEY);
}

// --- core get ---

/**
 * 設定値を取得する。優先順:
 *   1. DB に明示的に保存されてれば、その値 (空文字 = 「user が意図的に無効化」として null を返し、env/default に fall through しない)
 *   2. DB に未保存なら env
 *   3. それも無ければハードコード default
 *
 * is_secret な値もそのまま返すので、UI 用に取りたい時は getMaskedAiSettings を使うこと。
 */
export async function getAiSetting(key: AiSettingKey): Promise<string | null> {
  const map = await ensureCache();
  if (map.has(key)) {
    // DB に明示的に保存されてる → user の意図を尊重 (空文字なら「無効化」として null を返す)
    const v = map.get(key);
    return v && v.length > 0 ? v : null;
  }
  const spec = SPECS[key];
  if (spec.env) {
    const v = process.env[spec.env];
    if (v !== undefined && v !== "") return v;
  }
  return spec.default;
}

/** 数値で取りたい時 */
export async function getAiSettingNumber(
  key: AiSettingKey,
  fallback: number
): Promise<number> {
  const v = await getAiSetting(key);
  if (v === null) return fallback;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
}

/** boolean で取りたい時 ("true" / "1" → true) */
export async function getAiSettingBoolean(key: AiSettingKey): Promise<boolean> {
  const v = await getAiSetting(key);
  if (v === null) return false;
  const s = v.toLowerCase().trim();
  return s === "true" || s === "1" || s === "yes" || s === "on";
}

// --- 型付き helper (caller が使う) ---

export type AnthropicConfig = {
  apiKey: string | null;
  mainModel: string;
  haikuModel: string;
};

export async function getAnthropicConfig(): Promise<AnthropicConfig> {
  const [apiKey, mainModel, haikuModel] = await Promise.all([
    getAiSetting("anthropic_api_key"),
    getAiSetting("anthropic_main_model"),
    getAiSetting("anthropic_haiku_model"),
  ]);
  return {
    apiKey,
    mainModel: mainModel ?? "claude-sonnet-4-6",
    haikuModel: haikuModel ?? "claude-haiku-4-5",
  };
}

export type LocalLlmConfig = {
  enabled: boolean;
  url: string;
  model: string;
  /** どの role でローカル LLM を使うか (lowercase set) */
  roles: Set<string>;
};

export async function getLocalLlmConfig(): Promise<LocalLlmConfig> {
  const [enabled, url, model, rolesStr] = await Promise.all([
    getAiSettingBoolean("local_llm_enabled"),
    getAiSetting("local_llm_url"),
    getAiSetting("local_llm_model"),
    getAiSetting("local_llm_roles"),
  ]);
  const roles = new Set(
    (rolesStr ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  );
  return {
    enabled,
    url: url ?? SPECS.local_llm_url.default!,
    model: model ?? SPECS.local_llm_model.default!,
    roles,
  };
}

/** 指定 role でローカル LLM を使うべきか (enabled + roles 集合に含まれる)。
 * notify (MCP 進捗連絡の口調整形) は軽い整形なので、ローカル有効時は roles 設定に
 * 関係なく既定でローカル優先にする (失敗時は callLlm が hosted Haiku に fallback)。 */
export async function shouldUseLocalLlmFor(role: string): Promise<boolean> {
  const cfg = await getLocalLlmConfig();
  return cfg.enabled && (role === "notify" || cfg.roles.has(role));
}

/**
 * TTS server の base URL を返す。
 * 未設定 (= DB 空文字 / null / env 未設定) なら null を返し、呼出側で「TTS 無効」と扱う。
 */
export async function getTtsUrl(): Promise<string | null> {
  const v = await getAiSetting("tts_url");
  if (!v || !v.trim()) return null;
  return v.trim();
}

/**
 * 通常 chat voice 用の reference wav 絶対パス (TTS server から見える)。
 * 未設定なら null (= TTS server の default voice を使う)。
 */
export async function getTtsNormalRef(): Promise<string | null> {
  const v = await getAiSetting("tts_normal_ref");
  if (!v || !v.trim()) return null;
  return v.trim();
}

/**
 * Sleep モード囁き voice 用の reference wav 絶対パス (TTS server から見える)。
 * 未設定なら null (= 通常 voice で合成、囁き効果なし)。
 */
export async function getTtsWhisperRef(): Promise<string | null> {
  const v = await getAiSetting("tts_whisper_ref");
  if (!v || !v.trim()) return null;
  return v.trim();
}

export type EmbedConfig = {
  url: string;
  model: string;
  dimensions: number;
};

export async function getEmbedConfig(): Promise<EmbedConfig> {
  const [url, model, dims] = await Promise.all([
    getAiSetting("embed_url"),
    getAiSetting("embed_model"),
    getAiSettingNumber("embed_dimensions", 1024),
  ]);
  return {
    url: url ?? SPECS.embed_url.default!,
    model: model ?? SPECS.embed_model.default!,
    dimensions: dims,
  };
}

// --- 更新 / 一括取得 ---

/**
 * UI / API 表示用の一括取得。シークレットは masked=true なら "***...4 桁" にマスクする。
 * 戻り値の key は全 AiSettingKey を網羅 (値が無い key は default または null)。
 */
export async function getAllAiSettings(opts: {
  masked: boolean;
}): Promise<Record<AiSettingKey, string>> {
  const keys = Object.keys(SPECS) as AiSettingKey[];
  const entries = await Promise.all(
    keys.map(async (k) => {
      const v = (await getAiSetting(k)) ?? "";
      if (opts.masked && SECRET_KEYS.has(k) && v.length > 0) {
        const tail = v.slice(-4);
        return [k, `***...${tail}`] as const;
      }
      return [k, v] as const;
    })
  );
  return Object.fromEntries(entries) as Record<AiSettingKey, string>;
}

/**
 * 部分更新。シークレットは値が "" または "***" を含む特殊文字列なら無変更扱い
 * (UI からマスク済み値が誤って書き戻されるのを防ぐ)。
 */
export async function updateAiSettings(
  patch: Partial<Record<AiSettingKey, string>>
): Promise<void> {
  const rows: Array<{ key: string; value: string; isSecret: boolean }> = [];
  for (const [k, raw] of Object.entries(patch)) {
    const key = k as AiSettingKey;
    if (!(key in SPECS)) continue;
    if (raw === undefined) continue;
    // シークレットの "no-change" マーカー
    if (SECRET_KEYS.has(key) && (raw === "" || raw.includes("***"))) continue;
    rows.push({ key, value: raw, isSecret: SECRET_KEYS.has(key) });
  }
  if (rows.length === 0) return;

  for (const row of rows) {
    await db
      .insert(aiSettings)
      .values({
        key: row.key,
        value: row.value,
        isSecret: row.isSecret,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: aiSettings.key,
        set: {
          value: row.value,
          isSecret: row.isSecret,
          updatedAt: new Date(),
        },
      });
  }
  await invalidateCache();
}

/** 一括 reset (UI の「env / デフォルトに戻す」用) */
export async function resetAiSettings(keys: AiSettingKey[]): Promise<void> {
  if (keys.length === 0) return;
  await db.delete(aiSettings).where(inArray(aiSettings.key, keys));
  await invalidateCache();
}
