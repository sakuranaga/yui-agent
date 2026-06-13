/**
 * ゆい MCP サーバの認証トークン管理 (docs/yui-mcp-server.md §4)。
 *
 * - 自動生成 (32 byte base64url)。
 * - at-rest は AES-256-GCM 暗号化して ai_settings テーブルに直接保存 (= OAuth token と同方針)。
 *   汎用 getAiSetting/updateAiSettings を経由しない (= AiSettingKey/SPECS/SECRET_KEYS を汚さず、
 *   AI 設定 UI 経路と責務を分離する)。
 * - 可逆暗号にするのは「設定画面でいつでもスニペットを再表示する」要件のため (hash ではない)。
 *   トレードオフ: 設定画面アクセス権を持つ者にはトークン平文が見える (= 設定は cookie 認証済み前提)。
 * - 検証は timingSafeEqual で定数時間比較。
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { db } from "@/db/client";
import { aiSettings } from "@/db/schema";
import { eq } from "drizzle-orm";
import { encryptText, decryptText, isEncryptionConfigured } from "@/lib/crypto";

const TOKEN_KEY = "mcp_token_encrypted";

function generateToken(): string {
  return randomBytes(32).toString("base64url");
}

async function readEncrypted(): Promise<string | null> {
  const rows = await db
    .select({ value: aiSettings.value })
    .from(aiSettings)
    .where(eq(aiSettings.key, TOKEN_KEY))
    .limit(1);
  return rows[0]?.value ?? null;
}

async function writeToken(plaintext: string): Promise<void> {
  const value = encryptText(plaintext);
  await db
    .insert(aiSettings)
    .values({ key: TOKEN_KEY, value, isSecret: true, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: aiSettings.key,
      set: { value, isSecret: true, updatedAt: new Date() },
    });
}

/**
 * 現在の MCP トークンを返す (復号済み平文)。未生成なら生成して保存してから返す。
 * ENCRYPTION_KEY 未設定なら例外 (= 平文保存に倒さない)。
 */
export async function getMcpToken(): Promise<string> {
  if (!isEncryptionConfigured()) {
    throw new Error("ENCRYPTION_KEY is not configured; MCP token cannot be stored securely");
  }
  const enc = await readEncrypted();
  if (enc) {
    try {
      return decryptText(enc);
    } catch {
      // 復号不能 (鍵変更等) → 作り直す
    }
  }
  const fresh = generateToken();
  await writeToken(fresh);
  return fresh;
}

/** 新しいトークンを生成・保存して返す (= ローテート。旧トークンは即無効)。 */
export async function rotateMcpToken(): Promise<string> {
  if (!isEncryptionConfigured()) {
    throw new Error("ENCRYPTION_KEY is not configured; MCP token cannot be stored securely");
  }
  const fresh = generateToken();
  await writeToken(fresh);
  return fresh;
}

/**
 * 提示トークンが現在の MCP トークンと一致するか (= 定数時間比較)。
 * 長さ不一致でも timingSafeEqual が例外を投げないよう前段でガード。
 */
export async function verifyMcpToken(presented: string | null | undefined): Promise<boolean> {
  if (!presented) return false;
  let expected: string;
  try {
    expected = await getMcpToken();
  } catch {
    return false;
  }
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
