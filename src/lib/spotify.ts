/**
 * Spotify Web API クライアント (Apple Music からの完全移行)。
 *
 * - 個人 1 人専用 OSS、単一 user 前提 (= 常に spotify_oauth_tokens id=1)
 * - Free アカウントでも使える設計 (= Web Playback SDK を経由せず、
 *   Spotify Connect で他デバイス制御を行う。play/pause/transfer 系は
 *   Premium 必須なので Free だと 403 になる。再生中曲の取得や search は Free でも OK)
 * - redirect URI は SPOTIFY_REDIRECT_URI env 変数で設定可能 (= 既定 https://localhost/api/spotify/callback、
 *   Caddy + 自己署名証明書を経由する。Spotify は localhost を許容)
 *   旧構成 (= Caddy なし直接 http) は env で `http://127.0.0.1:3000/api/spotify/callback` を指定
 *
 * `src/lib/google-oauth.ts` と同じパターンを踏襲。
 */
import { db } from "@/db/client";
import { spotifyOauthTokens } from "@/db/schema";
import { eq } from "drizzle-orm";
import { getSpotifyClientCredentials } from "@/lib/integration-settings";
import { decryptText, encryptText } from "@/lib/crypto";

// ---------- 定数 ----------

/**
 * redirect URI (= Spotify dashboard 側に登録する値と一致させる)。
 * 既定は Caddy HTTPS 経由の https://localhost/api/spotify/callback。
 * 環境変数 SPOTIFY_REDIRECT_URI で旧構成 (http://127.0.0.1:3000/...) に切り替え可能。
 * Spotify dashboard で登録した URI と一致しないと OAuth が成立しないので、
 * 構成変更したら dashboard 側も同じ URI を許可リストに追加する。
 */
export const SPOTIFY_REDIRECT_URI =
  process.env.SPOTIFY_REDIRECT_URI ?? "https://localhost/api/spotify/callback";

/**
 * 必要 scope:
 * - user-read-playback-state / user-modify-playback-state / user-read-currently-playing:
 *   再生情報の取得と Spotify Connect 経由の制御 (Premium 必須)
 * - user-read-private: /me で product (free/premium) を判定
 * - user-read-email: Web Playback SDK の内部 check_scope で要求される
 *   (これが無いと SDK 初期化時に authentication_error: Invalid token scopes)
 * - streaming: Web Playback SDK で本ブラウザ自体を device 化する (Premium 必須)
 * - playlist-read-private / playlist-read-collaborative: playlist 一覧/検索
 */
export const SPOTIFY_SCOPES: ReadonlyArray<string> = [
  "user-read-playback-state",
  "user-modify-playback-state",
  "user-read-currently-playing",
  "user-read-private",
  "user-read-email",
  "streaming",
  "playlist-read-private",
  "playlist-read-collaborative",
];

const SPOTIFY_AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const SPOTIFY_TOKEN_URL = "https://accounts.spotify.com/api/token";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

/** access_token の手前で先回り refresh するマージン (秒) */
const REFRESH_MARGIN_SEC = 60;

/** 単一 user 前提なので row は 1 行固定 */
const SINGLETON_ID = 1;

// ---------- public type ----------

export type SpotifyMe = {
  id: string;
  display_name: string;
  product: "free" | "premium";
};

export type NowPlaying = {
  trackName: string;
  artistNames: string[];
  albumName: string;
  artworkUrl: string | null;
  isPlaying: boolean;
  progressMs: number;
  durationMs: number;
  trackUri: string;
};

export type SpotifyDevice = {
  id: string;
  name: string;
  type: string;
  isActive: boolean;
  volumePercent: number | null;
};

export type SpotifyTrack = {
  uri: string;
  name: string;
  artistNames: string[];
  albumName: string;
  artworkUrl: string | null;
};

export type SpotifyPlaylist = {
  uri: string;
  name: string;
  ownerName: string;
  imageUrl: string | null;
  trackCount: number;
};

// ---------- OAuth ----------

export async function isSpotifyClientConfigured(): Promise<boolean> {
  const cred = await getSpotifyClientCredentials();
  return cred !== null;
}

async function requireClientCredentials(): Promise<{ id: string; secret: string }> {
  const cred = await getSpotifyClientCredentials();
  if (!cred) {
    throw new Error(
      "Spotify client is not configured (set spotify_client_id / spotify_client_secret in integration settings, or SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET in .env)"
    );
  }
  return cred;
}

/** /api/spotify/authorize で使う Spotify 同意画面 URL を組み立てる */
export async function buildAuthorizationUrl(state: string): Promise<string> {
  const { id } = await requireClientCredentials();
  const params = new URLSearchParams({
    client_id: id,
    response_type: "code",
    redirect_uri: SPOTIFY_REDIRECT_URI,
    scope: SPOTIFY_SCOPES.join(" "),
    state,
    // 「Spotify が以前同意済」でも明示的に同意画面を出すか。false (default) のままで良い。
    // show_dialog: "false",
  });
  return `${SPOTIFY_AUTHORIZE_URL}?${params.toString()}`;
}

type TokenExchangeResponse = {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
};

function basicAuthHeader(clientId: string, clientSecret: string): string {
  const raw = `${clientId}:${clientSecret}`;
  return `Basic ${Buffer.from(raw, "utf-8").toString("base64")}`;
}

/** callback の code を refresh_token+access_token に交換 → DB 保存 */
export async function completeAuthorization(code: string): Promise<void> {
  const { id, secret } = await requireClientCredentials();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
  });
  // eslint-disable-next-line no-restricted-syntax -- Spotify OAuth 公式 endpoint 固定 (token exchange)
  const res = await fetch(SPOTIFY_TOKEN_URL, {
    method: "POST",
    headers: {
      Authorization: basicAuthHeader(id, secret),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Spotify token exchange failed ${res.status}: ${text}`);
  }
  const tok = (await res.json()) as TokenExchangeResponse;
  if (!tok.refresh_token) {
    throw new Error("Spotify did not return a refresh_token");
  }
  const expiresAt = new Date(Date.now() + tok.expires_in * 1000);
  const encryptedRefresh = encryptText(tok.refresh_token);
  const encryptedAccess = encryptText(tok.access_token);

  await db
    .insert(spotifyOauthTokens)
    .values({
      id: SINGLETON_ID,
      refreshToken: null,
      accessToken: null,
      encryptedRefreshToken: encryptedRefresh,
      encryptedAccessToken: encryptedAccess,
      expiresAt,
      scope: tok.scope,
    })
    .onConflictDoUpdate({
      target: spotifyOauthTokens.id,
      set: {
        refreshToken: null,
        accessToken: null,
        encryptedRefreshToken: encryptedRefresh,
        encryptedAccessToken: encryptedAccess,
        expiresAt,
        scope: tok.scope,
        updatedAt: new Date(),
      },
    });
}

type DecodedTokenRow = {
  id: number;
  refreshToken: string;
  accessToken: string | null;
  expiresAt: Date | null;
  scope: string | null;
};

async function loadTokenRow(): Promise<DecodedTokenRow | null> {
  const [row] = await db
    .select()
    .from(spotifyOauthTokens)
    .where(eq(spotifyOauthTokens.id, SINGLETON_ID))
    .limit(1);
  if (!row) return null;
  // encrypted 優先、なければ plaintext (= startup migration 前の legacy row)
  let refreshToken: string | null = null;
  if (row.encryptedRefreshToken) {
    refreshToken = decryptText(row.encryptedRefreshToken);
  } else if (row.refreshToken) {
    refreshToken = row.refreshToken;
  }
  if (!refreshToken) return null;
  let accessToken: string | null = null;
  if (row.encryptedAccessToken) {
    try {
      accessToken = decryptText(row.encryptedAccessToken);
    } catch {
      accessToken = null;
    }
  } else {
    accessToken = row.accessToken;
  }
  return {
    id: row.id,
    refreshToken,
    accessToken,
    expiresAt: row.expiresAt,
    scope: row.scope,
  };
}

// Singleton promise で同時 refresh を 1 本に束ねる (= 並列 caller が同じ
// refresh_token で並列に Spotify を叩いて、Spotify が新 refresh_token を返した時の
// last-write-wins race を防ぐ)。
// 在飛中なら既存 promise を返し、完了したら null に戻す。
let inflightRefresh: Promise<string> | null = null;

async function refreshAccessToken(refreshToken: string): Promise<string> {
  if (inflightRefresh) return inflightRefresh;
  inflightRefresh = (async () => {
    try {
      const { id, secret } = await requireClientCredentials();
      const body = new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      });
      // eslint-disable-next-line no-restricted-syntax -- Spotify OAuth 公式 endpoint 固定 (refresh)
      const res = await fetch(SPOTIFY_TOKEN_URL, {
        method: "POST",
        headers: {
          Authorization: basicAuthHeader(id, secret),
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: body.toString(),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Spotify token refresh failed ${res.status}: ${text}`);
      }
      const tok = (await res.json()) as TokenExchangeResponse;
      const expiresAt = new Date(Date.now() + tok.expires_in * 1000);
      // Spotify は refresh で新しい refresh_token を返すことがある (任意)
      await db
        .update(spotifyOauthTokens)
        .set({
          accessToken: null,
          encryptedAccessToken: encryptText(tok.access_token),
          expiresAt,
          scope: tok.scope,
          ...(tok.refresh_token
            ? {
                refreshToken: null,
                encryptedRefreshToken: encryptText(tok.refresh_token),
              }
            : {}),
          updatedAt: new Date(),
        })
        .where(eq(spotifyOauthTokens.id, SINGLETON_ID));
      return tok.access_token;
    } finally {
      inflightRefresh = null;
    }
  })();
  return inflightRefresh;
}

/**
 * access_token を取得。
 * DB に row が無ければ null (= 未連携)、有効期限まで 60s 切ってたら refresh。
 */
export async function getAccessToken(): Promise<string | null> {
  const row = await loadTokenRow();
  if (!row) return null;
  const now = Date.now();
  const expiresAtMs = row.expiresAt?.getTime() ?? 0;
  if (row.accessToken && expiresAtMs - now > REFRESH_MARGIN_SEC * 1000) {
    return row.accessToken;
  }
  return refreshAccessToken(row.refreshToken);
}

/** DB から token row を削除 (= 連携解除)。Spotify 側 revoke API は存在しないため DB 削除のみ。 */
export async function disconnect(): Promise<void> {
  await db
    .delete(spotifyOauthTokens)
    .where(eq(spotifyOauthTokens.id, SINGLETON_ID));
}

// ---------- Web API ラッパ共通 ----------

class SpotifyNotConnectedError extends Error {
  constructor() {
    super("Spotify not connected");
    this.name = "SpotifyNotConnectedError";
  }
}

class SpotifyPremiumRequiredError extends Error {
  constructor() {
    super("Spotify Premium が必要です");
    this.name = "SpotifyPremiumRequiredError";
  }
}

export function isSpotifyNotConnectedError(e: unknown): boolean {
  return e instanceof SpotifyNotConnectedError;
}

export function isSpotifyPremiumRequiredError(e: unknown): boolean {
  return e instanceof SpotifyPremiumRequiredError;
}

type SpotifyFetchInit = {
  method?: "GET" | "POST" | "PUT" | "DELETE";
  query?: Record<string, string | number | undefined>;
  body?: unknown;
};

/**
 * Spotify API を呼ぶ共通関数。
 * - access_token を自動取得
 * - 401 だったら 1 回だけ refresh して retry
 * - 403 は Premium 必須 endpoint と判断
 * - 204 (no content) は null を返す
 */
async function spotifyFetch<T>(
  path: string,
  init: SpotifyFetchInit = {}
): Promise<T | null> {
  const token = await getAccessToken();
  if (!token) throw new SpotifyNotConnectedError();
  return executeFetch<T>(path, init, token, /*retryOn401=*/ true);
}

async function executeFetch<T>(
  path: string,
  init: SpotifyFetchInit,
  token: string,
  retryOn401: boolean
): Promise<T | null> {
  const url = new URL(`${SPOTIFY_API_BASE}${path}`);
  if (init.query) {
    for (const [k, v] of Object.entries(init.query)) {
      if (v === undefined || v === null) continue;
      url.searchParams.set(k, String(v));
    }
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(init.body);
  }
  // eslint-disable-next-line no-restricted-syntax -- Spotify Web API 公式 endpoint 固定 (api.spotify.com)
  const res = await fetch(url.toString(), {
    method: init.method ?? "GET",
    headers,
    body,
  });

  if (res.status === 401 && retryOn401) {
    // refresh して 1 回だけ retry
    const row = await loadTokenRow();
    if (!row) throw new SpotifyNotConnectedError();
    const fresh = await refreshAccessToken(row.refreshToken);
    return executeFetch<T>(path, init, fresh, /*retryOn401=*/ false);
  }
  if (res.status === 401) {
    throw new SpotifyNotConnectedError();
  }
  if (res.status === 403) {
    throw new SpotifyPremiumRequiredError();
  }
  if (res.status === 204) {
    return null;
  }
  if (!res.ok) {
    const text = await res.text();
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[spotify-api] ${res.status} ${init.method ?? "GET"} ${path}: ${text}`);
    }
    throw new Error(`Spotify API ${res.status} ${path}: ${text}`);
  }
  // GET 以外でも JSON 返さないことがあるので length チェック
  const text = await res.text();
  if (text.length === 0) return null;
  return JSON.parse(text) as T;
}

// ---------- Web API 個別 endpoint ----------

type RawMe = {
  id: string;
  display_name?: string | null;
  product?: string;
};

export async function getMe(): Promise<SpotifyMe | null> {
  const me = await spotifyFetch<RawMe>("/me");
  if (!me) return null;
  const product: "free" | "premium" =
    me.product === "premium" ? "premium" : "free";
  return {
    id: me.id,
    display_name: me.display_name ?? me.id,
    product,
  };
}

type RawArtist = { name: string };
type RawImage = { url: string; width?: number; height?: number };
type RawAlbum = { name: string; images?: RawImage[] };
type RawTrack = {
  uri: string;
  name: string;
  artists: RawArtist[];
  album: RawAlbum;
  duration_ms: number;
};

type RawCurrentlyPlaying = {
  is_playing: boolean;
  progress_ms: number | null;
  item: RawTrack | null;
};

function pickArtwork(images: RawImage[] | undefined): string | null {
  if (!images || images.length === 0) return null;
  // Spotify は大きい順に並ぶ。中央サイズが扱いやすいので、3 枚あれば中央を、なければ最初を。
  if (images.length >= 3) return images[1]?.url ?? images[0]?.url ?? null;
  return images[0]?.url ?? null;
}

export async function getNowPlaying(): Promise<NowPlaying | null> {
  const raw = await spotifyFetch<RawCurrentlyPlaying>("/me/player/currently-playing");
  // 何も再生していない時は 204 → null
  if (!raw || !raw.item) return null;
  return {
    trackName: raw.item.name,
    artistNames: raw.item.artists.map((a) => a.name),
    albumName: raw.item.album.name,
    artworkUrl: pickArtwork(raw.item.album.images),
    isPlaying: raw.is_playing,
    progressMs: raw.progress_ms ?? 0,
    durationMs: raw.item.duration_ms,
    trackUri: raw.item.uri,
  };
}

type RawDevice = {
  id: string | null;
  name: string;
  type: string;
  is_active: boolean;
  volume_percent: number | null;
};

export async function getDevices(): Promise<SpotifyDevice[]> {
  const raw = await spotifyFetch<{ devices: RawDevice[] }>("/me/player/devices");
  if (!raw) return [];
  // id が null のデバイス (一時的) は弾く
  return raw.devices
    .filter((d): d is RawDevice & { id: string } => d.id !== null)
    .map((d) => ({
      id: d.id,
      name: d.name,
      type: d.type,
      isActive: d.is_active,
      volumePercent: d.volume_percent,
    }));
}

export async function transferPlayback(
  deviceId: string,
  play: boolean = false
): Promise<void> {
  await spotifyFetch<unknown>("/me/player", {
    method: "PUT",
    body: { device_ids: [deviceId], play },
  });
}

export type PlayOptions = {
  deviceId?: string;
  uris?: string[];
  contextUri?: string;
};

export async function play(opts: PlayOptions = {}): Promise<void> {
  const query: Record<string, string | undefined> = {};
  if (opts.deviceId) query.device_id = opts.deviceId;
  const body: Record<string, unknown> = {};
  if (opts.uris && opts.uris.length > 0) body.uris = opts.uris;
  if (opts.contextUri) body.context_uri = opts.contextUri;
  await spotifyFetch<unknown>("/me/player/play", {
    method: "PUT",
    query,
    body: Object.keys(body).length > 0 ? body : undefined,
  });
}

export async function pause(deviceId?: string): Promise<void> {
  await spotifyFetch<unknown>("/me/player/pause", {
    method: "PUT",
    query: deviceId ? { device_id: deviceId } : undefined,
  });
}

export async function next(deviceId?: string): Promise<void> {
  await spotifyFetch<unknown>("/me/player/next", {
    method: "POST",
    query: deviceId ? { device_id: deviceId } : undefined,
  });
}

export async function previous(deviceId?: string): Promise<void> {
  await spotifyFetch<unknown>("/me/player/previous", {
    method: "POST",
    query: deviceId ? { device_id: deviceId } : undefined,
  });
}

export async function setVolume(
  percent: number,
  deviceId?: string
): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const query: Record<string, string | number | undefined> = {
    volume_percent: clamped,
  };
  if (deviceId) query.device_id = deviceId;
  await spotifyFetch<unknown>("/me/player/volume", {
    method: "PUT",
    query,
  });
}

export async function seek(positionMs: number, deviceId?: string): Promise<void> {
  const clamped = Math.max(0, Math.floor(positionMs));
  const query: Record<string, string | number | undefined> = {
    position_ms: clamped,
  };
  if (deviceId) query.device_id = deviceId;
  await spotifyFetch<unknown>("/me/player/seek", {
    method: "PUT",
    query,
  });
}

type RawSearchTracks = {
  tracks?: { items: RawTrack[] };
};

export async function searchTracks(
  query: string,
  limit = 20
): Promise<SpotifyTrack[]> {
  const clamped = Math.max(1, Math.min(50, Math.floor(limit)));
  const raw = await spotifyFetch<RawSearchTracks>("/search", {
    query: { q: query, type: "track", limit: clamped },
  });
  const items = raw?.tracks?.items ?? [];
  return items.map((t) => ({
    uri: t.uri,
    name: t.name,
    artistNames: t.artists.map((a) => a.name),
    albumName: t.album.name,
    artworkUrl: pickArtwork(t.album.images),
  }));
}

type RawPlaylistOwner = { display_name?: string | null; id: string };
type RawPlaylist = {
  uri: string;
  name: string;
  owner: RawPlaylistOwner;
  images?: RawImage[];
  tracks?: { total: number };
};

type RawSearchPlaylists = {
  playlists?: { items: Array<RawPlaylist | null> };
};

export async function searchPlaylists(
  query: string,
  limit = 20
): Promise<SpotifyPlaylist[]> {
  const clamped = Math.max(1, Math.min(50, Math.floor(limit)));
  const raw = await spotifyFetch<RawSearchPlaylists>("/search", {
    query: { q: query, type: "playlist", limit: clamped },
  });
  const items = raw?.playlists?.items ?? [];
  // Spotify search は時々 null entry を返すので filter
  return items
    .filter((p): p is RawPlaylist => p !== null)
    .map((p) => ({
      uri: p.uri,
      name: p.name,
      ownerName: p.owner.display_name ?? p.owner.id,
      imageUrl: pickArtwork(p.images),
      trackCount: p.tracks?.total ?? 0,
    }));
}
