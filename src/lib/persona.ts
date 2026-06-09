/**
 * 秘書 (Yui) の persona 設定の load/save。
 *
 * 単一行 (id=1)。migration で initial row が必ず作られている前提だが、
 * 念のため load 時に欠損していたら defaults を返すフォールバックを置く。
 */
import { db } from "@/db/client";
import { personaSettings, promptPresets } from "@/db/schema";
import { eq } from "drizzle-orm";

/**
 * "auto" = 会話の文脈から Yui が work/relax を自動判断する (default)
 * "work" / "relax" = ユーザーが明示的に固定
 *
 * 将来モード追加するならここに足す。
 */
export type PersonaMode = "auto" | "work" | "relax";
export const VALID_MODES: ReadonlyArray<PersonaMode> = ["auto", "work", "relax"];

export type Persona = {
  secretaryName: string;
  secretaryNameReading: string;
  userAddressWork: string;
  userAddressRelax: string;
  currentMode: PersonaMode;
  /** 有効化中の追加プロンプト ID (NULL = なし) */
  activePromptPresetId: number | null;
  /** 有効化中の追加プロンプト本文 (load 時に JOIN で取得、無ければ null) */
  activePromptPresetBody: string | null;
  updatedAt: string; // ISO string
};

export const DEFAULT_PERSONA: Persona = {
  secretaryName: "結衣",
  secretaryNameReading: "ゆい",
  userAddressWork: "ご主人様",
  userAddressRelax: "ご主人様",
  currentMode: "auto",
  activePromptPresetId: null,
  activePromptPresetBody: null,
  updatedAt: new Date(0).toISOString(),
};

/** 現在の persona 設定を取得 (single row、なければ defaults) */
export async function loadPersona(): Promise<Persona> {
  try {
    const rows = await db.select().from(personaSettings).limit(1);
    const row = rows[0];
    if (!row) return DEFAULT_PERSONA;
    let activeBody: string | null = null;
    if (row.activePromptPresetId !== null && row.activePromptPresetId !== undefined) {
      const preset = await db
        .select()
        .from(promptPresets)
        .where(eq(promptPresets.id, row.activePromptPresetId))
        .limit(1);
      activeBody = preset[0]?.body ?? null;
    }
    return {
      secretaryName: row.secretaryName,
      secretaryNameReading: row.secretaryNameReading,
      userAddressWork: row.userAddressWork,
      userAddressRelax: row.userAddressRelax,
      currentMode: row.currentMode,
      activePromptPresetId: row.activePromptPresetId ?? null,
      activePromptPresetBody: activeBody,
      updatedAt: row.updatedAt.toISOString(),
    };
  } catch (e) {
    console.warn("[persona] load failed, returning defaults:", e);
    return DEFAULT_PERSONA;
  }
}

/**
 * モードが work/relax のとき固定で対応する呼び方を返す。
 * auto のときはどちらでもないので null。auto 時の判断は Yui プロンプト側で行う。
 */
export function fixedUserAddress(p: Persona): string | null {
  if (p.currentMode === "work") return p.userAddressWork;
  if (p.currentMode === "relax") return p.userAddressRelax;
  return null;
}

export type PersonaUpdate = Partial<
  Pick<
    Persona,
    | "secretaryName"
    | "secretaryNameReading"
    | "userAddressWork"
    | "userAddressRelax"
    | "currentMode"
    | "activePromptPresetId"
  >
>;

/** persona 設定を更新 (部分 update OK) */
export async function savePersona(update: PersonaUpdate): Promise<Persona> {
  // バリデーション (簡易)
  if (update.secretaryName !== undefined && update.secretaryName.trim() === "") {
    throw new Error("secretaryName cannot be empty");
  }
  if (update.currentMode !== undefined && !VALID_MODES.includes(update.currentMode)) {
    throw new Error(`currentMode must be one of: ${VALID_MODES.join(", ")}`);
  }

  const setValues: Record<string, unknown> = { updatedAt: new Date() };
  if (update.secretaryName !== undefined)
    setValues.secretaryName = update.secretaryName.trim();
  if (update.secretaryNameReading !== undefined)
    setValues.secretaryNameReading = update.secretaryNameReading.trim();
  if (update.userAddressWork !== undefined)
    setValues.userAddressWork = update.userAddressWork.trim();
  if (update.userAddressRelax !== undefined)
    setValues.userAddressRelax = update.userAddressRelax.trim();
  if (update.currentMode !== undefined) setValues.currentMode = update.currentMode;
  if (update.activePromptPresetId !== undefined)
    setValues.activePromptPresetId = update.activePromptPresetId;

  await db.update(personaSettings).set(setValues).where(eq(personaSettings.id, 1));

  return loadPersona();
}
