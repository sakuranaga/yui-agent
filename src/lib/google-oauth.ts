/**
 * Google OAuth 2.0 (Web flow) ヘルパー。
 *
 * - 公式 hosted MCP (calendarmcp.googleapis.com / gmailmcp.googleapis.com) を
 *   叩くための access_token を確保するのが目的。
 * - 単一ユーザー Yui 前提だが、複数 Google アカウント対応に発展できるよう
 *   account_email を unique key に取る設計。
 * - refresh_token は DB (google_oauth_tokens) に保存。access_token は短寿命
 *   キャッシュとして同じ row に置く (有効期限 30 秒切ったら refresh)。
 *
 * Phase B continuation。docs/google-oauth-setup.md 参照。
 */
import { db } from "@/db/client";
import { googleOauthTokens } from "@/db/schema";
import { eq } from "drizzle-orm";
import { decryptText, encryptText } from "@/lib/crypto";

// Calendar は読み書き両方 (イベント追加/削除も含む)、Gmail は読み取りのみ。
// 後でメール送信も欲しくなったら gmail.send 追加 → 一度 disconnect → 再 connect で
// 新スコープの同意画面が出る。
export const SCOPES = [
  "openid",
  "email",
  // calendar.events: 個別イベントの CRUD (作成/更新/削除/取得)
  // calendar.readonly よりも狭い権限の組み合わせで、calendar list 全体の管理権限は持たない
  "https://www.googleapis.com/auth/calendar.events",
  // calendar.readonly: 他人と共有された calendar の閲覧、freeBusy 検索など
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.compose",
  // cloud-platform: Google Cloud の MCP API (calendarmcp/gmailmcp) を OAuth ユーザーとして
  // 叩く際に必要。同意画面では「Google Cloud Platform 上でのユーザーとしてサービスを操作」
  // のように表示される。広範な scope なので注意 (ただし下位の calendar/gmail スコープと
  // 組み合わせることで実質的な権限は data scope 側で制限される)。
  "https://www.googleapis.com/auth/cloud-platform",
];

const GOOGLE_OAUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const GOOGLE_USERINFO_URL = "https://openidconnect.googleapis.com/v1/userinfo";

// access_token の手前で先回り refresh するマージン (秒)
const REFRESH_MARGIN_SEC = 60;

export function isGoogleClientConfigured(): boolean {
  return !!(
    process.env.GOOGLE_CLIENT_ID &&
    process.env.GOOGLE_CLIENT_SECRET &&
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * GCP プロジェクト ID (NAME ではなく ID)。.env GOOGLE_CLOUD_PROJECT から。
 * Calendar/Gmail v3/v1 を OAuth ユーザートークンで叩く際、
 * X-Goog-User-Project ヘッダに乗せると quota billing が明示できる (なくても動くが推奨)。
 */
export function googleCloudProject(): string | null {
  return process.env.GOOGLE_CLOUD_PROJECT ?? null;
}

function clientConfig(): {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
} {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI;
  if (!clientId || !clientSecret || !redirectUri) {
    throw new Error(
      "Google OAuth client is not configured (.env: GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REDIRECT_URI)"
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** /api/auth/google/start で使う Google 同意画面の URL を組み立てる */
export function buildAuthorizationUrl(state: string): string {
  const { clientId, redirectUri } = clientConfig();
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    // refresh_token を必ず返してもらうため。consent は再連携時に新スコープ
    // 同意画面を強制するためにも必要。
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state,
  });
  return `${GOOGLE_OAUTH_URL}?${params.toString()}`;
}

type TokenExchangeResponse = {
  access_token: string;
  expires_in: number;
  refresh_token?: string;
  scope: string;
  token_type: string;
  id_token?: string;
};

/** callback の code を refresh_token+access_token に交換 */
async function exchangeCodeForTokens(code: string): Promise<TokenExchangeResponse> {
  const { clientId, clientSecret, redirectUri } = clientConfig();
  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: "authorization_code",
  });
  // eslint-disable-next-line no-restricted-syntax -- Google OAuth 公式 endpoint 固定
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`token exchange failed ${res.status}: ${text}`);
  }
  return (await res.json()) as TokenExchangeResponse;
}

async function fetchUserEmail(accessToken: string): Promise<string> {
  // eslint-disable-next-line no-restricted-syntax -- Google userinfo 公式 endpoint 固定
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`userinfo failed ${res.status}`);
  }
  const data = (await res.json()) as { email?: string };
  if (!data.email) throw new Error("userinfo: no email field");
  return data.email;
}

/**
 * callback ハンドラから呼ぶ: code を受け取って token を保存。
 * 戻り値はユーザーに表示する email。
 */
export async function completeAuthorization(code: string): Promise<string> {
  const tok = await exchangeCodeForTokens(code);
  if (!tok.refresh_token) {
    // prompt=consent + access_type=offline で必ず返るはずだが念のため
    throw new Error(
      "Google did not return a refresh_token. Try disconnecting from your Google account's third-party access and reconnecting."
    );
  }
  const email = await fetchUserEmail(tok.access_token);
  const grantedScopes = tok.scope.split(/\s+/).filter(Boolean);
  const expiresAt = new Date(Date.now() + tok.expires_in * 1000);

  // 新規書き込みは encrypted 列のみ。plaintext は null で明示的に上書き
  // (= 旧 row が再連携された場合、残骸を残さない)。
  const encryptedRefresh = encryptText(tok.refresh_token);
  const encryptedAccess = encryptText(tok.access_token);

  await db
    .insert(googleOauthTokens)
    .values({
      accountEmail: email,
      scopes: grantedScopes,
      refreshToken: null,
      accessToken: null,
      encryptedRefreshToken: encryptedRefresh,
      encryptedAccessToken: encryptedAccess,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: googleOauthTokens.accountEmail,
      set: {
        scopes: grantedScopes,
        refreshToken: null,
        accessToken: null,
        encryptedRefreshToken: encryptedRefresh,
        encryptedAccessToken: encryptedAccess,
        expiresAt,
        updatedAt: new Date(),
      },
    });

  return email;
}

/**
 * row から refresh_token を取り出す (encrypted を優先、plaintext は legacy)。
 * 起動 migration が走るまでの一時的フォールバック。
 */
function readRefreshToken(row: {
  refreshToken: string | null;
  encryptedRefreshToken: string | null;
}): string {
  if (row.encryptedRefreshToken) return decryptText(row.encryptedRefreshToken);
  if (row.refreshToken) return row.refreshToken;
  throw new Error("google_oauth_tokens row has neither encrypted nor plaintext refresh_token");
}

function readAccessToken(row: {
  accessToken: string | null;
  encryptedAccessToken: string | null;
}): string | null {
  if (row.encryptedAccessToken) {
    try {
      return decryptText(row.encryptedAccessToken);
    } catch {
      // access_token は短寿命なので decrypt 失敗時は null にして refresh させる
      return null;
    }
  }
  return row.accessToken;
}

/**
 * 現在保存されている最初のトークン row を返す (単一アカウント想定の legacy API)。
 * 複数アカウント時は loadTokenByEmail / getAccessTokenForEmail を使うこと。
 */
export async function loadCurrentToken() {
  const rows = await db
    .select()
    .from(googleOauthTokens)
    .orderBy(googleOauthTokens.updatedAt)
    .limit(1);
  return rows[0] ?? null;
}

/** 特定 email の token を返す (multi-account 用) */
export async function loadTokenByEmail(email: string) {
  const [row] = await db
    .select()
    .from(googleOauthTokens)
    .where(eq(googleOauthTokens.accountEmail, email))
    .limit(1);
  return row ?? null;
}

/**
 * 共通の refresh ロジック。row が新鮮ならそのまま返し、期限切れ間近なら refresh する。
 */
async function ensureFreshToken(row: NonNullable<Awaited<ReturnType<typeof loadCurrentToken>>>): Promise<string> {
  const now = Date.now();
  const expiresAtMs = row.expiresAt?.getTime() ?? 0;
  const cachedAccess = readAccessToken(row);
  if (cachedAccess && expiresAtMs - now > REFRESH_MARGIN_SEC * 1000) {
    return cachedAccess;
  }

  const { clientId, clientSecret } = clientConfig();
  const refreshToken = readRefreshToken(row);
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token",
  });
  // eslint-disable-next-line no-restricted-syntax -- Google OAuth 公式 endpoint 固定 (refresh)
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`refresh failed ${res.status}: ${text}`);
  }
  const tok = (await res.json()) as TokenExchangeResponse;
  const newExpiresAt = new Date(Date.now() + tok.expires_in * 1000);

  await db
    .update(googleOauthTokens)
    .set({
      accessToken: null,
      encryptedAccessToken: encryptText(tok.access_token),
      expiresAt: newExpiresAt,
      updatedAt: new Date(),
    })
    .where(eq(googleOauthTokens.id, row.id));

  return tok.access_token;
}

/**
 * access_token を refresh_token から発行 (まだ有効ならキャッシュをそのまま返す)。
 * specialist 実行時に呼んで Anthropic mcp_servers の authorization_token に乗せる。
 * 単一アカウント想定 (legacy)。
 */
export async function getAccessTokenForMcp(): Promise<string> {
  const row = await loadCurrentToken();
  if (!row) {
    throw new Error("Google account is not connected. Visit /settings to connect.");
  }
  return ensureFreshToken(row);
}

/**
 * 指定 email の access_token を取得 (multi-account 用)。
 * mail-poll が各 enabled Gmail アカウントに対して呼ぶ。
 */
export async function getAccessTokenForEmail(email: string): Promise<string> {
  const row = await loadTokenByEmail(email);
  if (!row) {
    throw new Error(`Google account ${email} is not connected.`);
  }
  return ensureFreshToken(row);
}

/** /api/auth/google/disconnect から呼ぶ: Google 側 revoke + DB 削除 */
export async function disconnectGoogle(): Promise<void> {
  const row = await loadCurrentToken();
  if (!row) return;
  // ベストエフォートで revoke (失敗しても row は消す)
  try {
    const refreshToken = readRefreshToken(row);
    // eslint-disable-next-line no-restricted-syntax -- Google revoke 公式 endpoint 固定
    await fetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: refreshToken }).toString(),
    });
  } catch (e) {
    console.warn("[google-oauth] revoke failed (ignoring):", e);
  }
  await db.delete(googleOauthTokens).where(eq(googleOauthTokens.id, row.id));
}

export type GoogleConnectionStatus =
  | { connected: false; clientConfigured: boolean }
  | {
      connected: true;
      clientConfigured: true;
      email: string;
      scopes: string[];
      connectedAt: string;
    };

export async function getConnectionStatus(): Promise<GoogleConnectionStatus> {
  const clientConfigured = isGoogleClientConfigured();
  if (!clientConfigured) return { connected: false, clientConfigured: false };
  const row = await loadCurrentToken();
  if (!row) return { connected: false, clientConfigured: true };
  return {
    connected: true,
    clientConfigured: true,
    email: row.accountEmail,
    scopes: row.scopes,
    connectedAt: row.createdAt.toISOString(),
  };
}
