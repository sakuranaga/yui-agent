/**
 * 起動時に走る OAuth token の plaintext → encrypted migration。
 *
 * migration 0059 で encrypted_* 列を追加した直後は、既存 row はまだ plaintext 側にしか
 * 入っていない。次回の refresh 時に新側へ落ちる動きだが、それまでの間 DB dump を
 * 取られると平文がバレるので、起動時に即時 encrypt して plaintext を NULL に倒す。
 *
 * 副作用なし (= 既に encrypted な row はスキップ)。ENCRYPTION_KEY 未設定なら
 * 黙ってスキップ (= startup を fail させない、別の警告経路に任せる)。
 */
import { db } from "@/db/client";
import { googleOauthTokens, spotifyOauthTokens } from "@/db/schema";
import { eq, and, isNotNull, isNull } from "drizzle-orm";
import { encryptText, isEncryptionConfigured } from "@/lib/crypto";

export async function migrateOAuthTokensToEncrypted(): Promise<void> {
  if (!isEncryptionConfigured()) {
    console.warn(
      "[oauth-encrypt-migrate] ENCRYPTION_KEY not set — skipping startup migration. " +
        "OAuth tokens remain plaintext in DB until ENCRYPTION_KEY is configured."
    );
    return;
  }

  // --- Google ---
  const googleRows = await db
    .select({
      id: googleOauthTokens.id,
      refreshToken: googleOauthTokens.refreshToken,
      accessToken: googleOauthTokens.accessToken,
    })
    .from(googleOauthTokens)
    .where(
      and(
        isNull(googleOauthTokens.encryptedRefreshToken),
        isNotNull(googleOauthTokens.refreshToken)
      )
    );

  for (const row of googleRows) {
    if (!row.refreshToken) continue;
    const updates: {
      refreshToken: string | null;
      encryptedRefreshToken: string;
      accessToken?: string | null;
      encryptedAccessToken?: string;
      updatedAt: Date;
    } = {
      refreshToken: null,
      encryptedRefreshToken: encryptText(row.refreshToken),
      updatedAt: new Date(),
    };
    if (row.accessToken) {
      updates.accessToken = null;
      updates.encryptedAccessToken = encryptText(row.accessToken);
    }
    await db
      .update(googleOauthTokens)
      .set(updates)
      .where(eq(googleOauthTokens.id, row.id));
    console.log(`[oauth-encrypt-migrate] encrypted google_oauth_tokens id=${row.id}`);
  }

  // --- Spotify ---
  const spotifyRows = await db
    .select({
      id: spotifyOauthTokens.id,
      refreshToken: spotifyOauthTokens.refreshToken,
      accessToken: spotifyOauthTokens.accessToken,
    })
    .from(spotifyOauthTokens)
    .where(
      and(
        isNull(spotifyOauthTokens.encryptedRefreshToken),
        isNotNull(spotifyOauthTokens.refreshToken)
      )
    );

  for (const row of spotifyRows) {
    if (!row.refreshToken) continue;
    const updates: {
      refreshToken: string | null;
      encryptedRefreshToken: string;
      accessToken?: string | null;
      encryptedAccessToken?: string;
      updatedAt: Date;
    } = {
      refreshToken: null,
      encryptedRefreshToken: encryptText(row.refreshToken),
      updatedAt: new Date(),
    };
    if (row.accessToken) {
      updates.accessToken = null;
      updates.encryptedAccessToken = encryptText(row.accessToken);
    }
    await db
      .update(spotifyOauthTokens)
      .set(updates)
      .where(eq(spotifyOauthTokens.id, row.id));
    console.log(`[oauth-encrypt-migrate] encrypted spotify_oauth_tokens id=${row.id}`);
  }
}
