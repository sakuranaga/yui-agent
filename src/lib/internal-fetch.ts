/**
 * 内部 self-fetch helper。同一 process / docker network 内で /api/* を叩く時、
 * middleware の認証ゲートを X-Internal-Auth ヘッダで通過させる。
 *
 * 使い方:
 *   await internalFetch(`http://localhost:3000/api/chat`, { method: "POST", body: ... });
 *
 * AUTH_TOKEN が未設定なら header 無しで叩く (= middleware が 503 を返すが、エラーは
 * caller 側で見える)。
 */

const INTERNAL_HEADER = "X-Internal-Auth";

export async function internalFetch(
  url: string,
  init: RequestInit = {}
): Promise<Response> {
  const token = process.env.AUTH_TOKEN ?? "";
  const headers = new Headers(init.headers);
  if (token) {
    headers.set(INTERNAL_HEADER, token);
  }
  return fetch(url, { ...init, headers });
}
