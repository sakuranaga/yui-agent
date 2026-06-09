/**
 * POST /api/auth/login
 *
 * Body: { token: string }
 * 成功時: 200 + Set-Cookie vroid-auth=<token>; HttpOnly; Secure; SameSite=Strict; Max-Age=30 days
 * 失敗時: 401 + 1 秒 sleep (= 失敗試行のフィードバックループを遅らせる)
 *
 * 設計メモ:
 * - cookie 自体に AUTH_TOKEN の値そのものを保存する (= session store 不要、単一ユーザ前提)。
 *   cookie が漏れたら token rotate (= .env 書き換え + compose restart) で全 session を無効化。
 * - 失敗時の 1 秒 sleep は **per-request** の遅延であり throughput 制限ではない。並列
 *   リクエストは同時にカウントできるので、文字通りの「1 試行/秒」にはならない。それでも
 *   この遅延だけで十分なのは、AUTH_TOKEN が 256-bit random (openssl rand -base64 32) を
 *   推奨しており brute-force 自体が現実的でないため。IP 単位の rate limit は意図的に
 *   未実装 (= 単一ユーザ前提・自宅 LAN 配備で複雑度に見合わない)。
 */
import { NextResponse, type NextRequest } from "next/server";
import { createHash, timingSafeEqual } from "node:crypto";

export const dynamic = "force-dynamic";

const COOKIE_NAME = "vroid-auth";
const COOKIE_MAX_AGE_SEC = 60 * 60 * 24 * 30; // 30 日

/**
 * constant-time 比較。SHA-256 で固定長 (32 bytes) に正規化することで「入力長依存の
 * length oracle」を消す。node:crypto.timingSafeEqual は同長配列に対し定数時間。
 */
function timingSafeEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

export async function POST(req: NextRequest) {
  const expected = process.env.AUTH_TOKEN;
  if (!expected || expected.trim().length === 0) {
    return NextResponse.json(
      { error: "AUTH_TOKEN env not set on server" },
      { status: 503 }
    );
  }

  let body: { token?: string };
  try {
    body = (await req.json()) as { token?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  const provided = typeof body.token === "string" ? body.token : "";
  if (!provided) {
    return NextResponse.json({ error: "token required" }, { status: 400 });
  }

  if (!timingSafeEq(provided, expected)) {
    // 失敗試行のフィードバックループを遅らせる per-request 遅延 (= throughput 制限ではない)。
    // 詳細は冒頭の設計メモ参照。
    await sleep(1000);
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  // Caddy 経由の HTTPS でのみ送信される (= dev で直 http://web:3000 を叩いても cookie 送られない)
  res.cookies.set(COOKIE_NAME, expected, {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SEC,
  });
  return res;
}
