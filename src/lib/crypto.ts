/**
 * 機密データの at-rest 暗号化 helper。
 *
 * OAuth refresh token / 将来の他長命トークン (= スコープが大きいもの) を DB に
 * 平文で保存しないため、AES-256-GCM で暗号化する。
 *
 * 鍵管理:
 *   - env ENCRYPTION_KEY (= base64 32 byte) で 1 つ管理
 *   - 生成例: `openssl rand -base64 32`
 *   - 未設定なら encrypt/decrypt は throw (= 「気づかないうちに平文に戻る」事故防止)
 *
 * Format: <iv 12 byte> + <ciphertext n byte> + <auth tag 16 byte> を base64 にした 1 文字列。
 *   先頭 1 byte は version (= 将来の鍵 rotation / アルゴリズム変更時に判定)
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const VERSION_BYTE = 0x01; // v1 = AES-256-GCM
const IV_LEN = 12;
const TAG_LEN = 16;

let cachedKey: Buffer | null = null;
function loadKey(): Buffer {
  if (cachedKey) return cachedKey;
  const raw = process.env.ENCRYPTION_KEY ?? "";
  if (!raw) {
    throw new Error(
      "ENCRYPTION_KEY env not set. Generate with: openssl rand -base64 32"
    );
  }
  // base64 32 byte (= 44 char) を期待。他形式 (= hex 64) も許容
  let buf: Buffer;
  try {
    buf = Buffer.from(raw, "base64");
    if (buf.length !== 32) {
      // hex 試行
      const hex = Buffer.from(raw, "hex");
      if (hex.length === 32) buf = hex;
      else
        throw new Error(
          `ENCRYPTION_KEY must decode to 32 bytes (got ${buf.length} from base64). ` +
            `Generate with: openssl rand -base64 32`
        );
    }
  } catch (e) {
    throw new Error(`ENCRYPTION_KEY parse failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  cachedKey = buf;
  return buf;
}

/** plaintext を暗号化して base64 string で返す */
export function encryptText(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const out = Buffer.concat([Buffer.from([VERSION_BYTE]), iv, ct, tag]);
  return out.toString("base64");
}

/** base64 暗号文を decrypt。invalid なら throw */
export function decryptText(b64: string): string {
  const key = loadKey();
  const buf = Buffer.from(b64, "base64");
  if (buf.length < 1 + IV_LEN + TAG_LEN + 1) {
    throw new Error("ciphertext too short");
  }
  const version = buf[0];
  if (version !== VERSION_BYTE) {
    throw new Error(`unknown ciphertext version: ${version}`);
  }
  const iv = buf.subarray(1, 1 + IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(1 + IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf-8");
}

/** env が設定されてるかを起動時にだけ呼んで判定する用 (= startup チェック) */
export function isEncryptionConfigured(): boolean {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}
