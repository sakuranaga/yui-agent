/**
 * 認証ゲート (= 単一ユーザ前提の共有トークン方式)。
 *
 * 設計:
 *   - process.env.AUTH_TOKEN を「正解の token」とする (.env で設定)
 *   - cookie `vroid-auth` に同じ値が乗っていれば通過、無ければ /auth へリダイレクト
 *   - 比較は定数時間 (timingSafeEqual) でタイミング攻撃を防ぐ
 *   - /api/* で未認証なら 401 JSON (= ブラウザ navigation でなく fetch なので redirect しない)
 *
 * pass-through (= 認証不要):
 *   - /auth (ログイン画面そのもの)
 *   - /api/auth/login, /api/auth/logout (= ログイン API そのもの)
 *   - /api/health/import (= 既存の X-Internal-Auth ヘッダ経由、iOS Shortcut 用に維持)
 *   - /api/auth/google/callback, /api/spotify/callback (= 外部 IdP からの redirect。
 *     authCookie は SameSite=Strict なのでクロスサイト復路では落ちて 401 になる。
 *     callback 側は state cookie 比較で CSRF を防いでいるので public 化して可)
 *   - /_next/*, /favicon.ico 等の Next.js 内部静的アセット
 *
 * AUTH_TOKEN 未設定時の挙動:
 *   - middleware は「設定漏れ」と判断して全リクエストを refuse (= 503)
 *   - 配布物として「token 設定し忘れ → 認証バイパス」事故を防ぐ
 */
import { NextResponse, type NextRequest } from "next/server";

const COOKIE_NAME = "vroid-auth";

// public path = 認証なしで通過させる (= ログイン画面 / 静的アセット / 別経路認証 API)
const PUBLIC_PATHS = [
  "/auth",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/health/import", // iOS Shortcut 用、独自 X-Internal-Auth ヘッダで認証
  // OAuth 外部 IdP からの戻り (= cross-site redirect で SameSite=Strict cookie が落ちる)。
  // CSRF は callback 側の state cookie 一致で防いでいる。
  "/api/auth/google/callback",
  "/api/spotify/callback",
  "/favicon.ico",
];

function isPublic(path: string): boolean {
  for (const p of PUBLIC_PATHS) {
    if (path === p || path.startsWith(p + "/")) return true;
  }
  // Next.js 内部静的アセット
  if (path.startsWith("/_next/")) return true;
  return false;
}

/**
 * 入力 a, b の constant-time 比較。SHA-256 で固定長 (32 bytes) に正規化してから
 * 各バイトを XOR で集約することで「入力長 (= ループ回数) 依存の length oracle」を消す。
 * Web Crypto の subtle.digest は Edge / Node 両 runtime で動くので、proxy.ts の
 * 実行環境を問わない。
 */
async function timingSafeEq(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const va = new Uint8Array(ha);
  const vb = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < 32; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (isPublic(pathname)) {
    return NextResponse.next();
  }

  const expected = process.env.AUTH_TOKEN;

  // AUTH_TOKEN 未設定 = 配布物としての安全性のため、全 request を refuse。
  // .env に AUTH_TOKEN を設定して compose restart させる。
  if (!expected || expected.trim().length === 0) {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json(
        { error: "AUTH_TOKEN env not set on server (configure in .env then restart)" },
        { status: 503 }
      );
    }
    return new NextResponse(
      "<html><body style='font-family:sans-serif;padding:2rem;max-width:48rem;margin:auto;'>" +
        "<h1>サーバ未設定</h1>" +
        "<p><code>AUTH_TOKEN</code> 環境変数が未設定です。<code>.env</code> に追記して " +
        "<code>docker compose restart</code> してください。</p>" +
        "<pre>AUTH_TOKEN=$(openssl rand -base64 32)</pre>" +
        "</body></html>",
      { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
    );
  }

  // 内部呼び出し (= Discord bot、cron jobs から `fetch http://localhost:3000/api/chat` 等)
  // は cookie を持たないため、専用ヘッダ X-Internal-Auth: <AUTH_TOKEN> で認証。
  // process 内 fetch は localhost なので Caddy を経由しない = HTTPS 必須化されない。
  const internalHeader = req.headers.get("x-internal-auth") ?? "";
  if (internalHeader && (await timingSafeEq(internalHeader, expected))) {
    return NextResponse.next();
  }

  const cookie = req.cookies.get(COOKIE_NAME)?.value ?? "";
  if (cookie && (await timingSafeEq(cookie, expected))) {
    return NextResponse.next();
  }

  // 未認証
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  // ページ navigation は /auth へ。?next= で元の URL に復帰させる
  const url = req.nextUrl.clone();
  url.pathname = "/auth";
  url.searchParams.set("next", pathname + req.nextUrl.search);
  return NextResponse.redirect(url);
}

// 静的アセット (.next/_next、_static、画像など) は完全 skip。
// Next.js の matcher で正規表現 negative lookahead を使う公式パターン:
export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
