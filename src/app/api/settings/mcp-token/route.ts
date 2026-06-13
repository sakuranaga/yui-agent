/**
 * MCP トークン管理 API (docs/yui-mcp-server.md §4.3)。
 *
 * - **cookie 認証必須**: /api/mcp と違い PUBLIC_PATHS に入れない (= proxy.ts の cookie ゲートで守る)。
 *   トークン平文を返すので、設定画面 (認証済) からのみアクセスさせる。
 * - GET  : 現在のトークンを返す (未生成なら生成)。
 * - POST : ローテート (新規生成 → 旧トークン即無効)。
 *
 * スニペット (claude mcp add ...) は接続元 host が可変なので client 側 (window.location.origin)
 * で組み立てる。ここではトークンだけ返す。
 */
import type { NextRequest } from "next/server";
import { getMcpToken, rotateMcpToken } from "@/lib/mcp-token";
import { clientError } from "@/lib/api-error";

export const runtime = "nodejs";

// 平文 secret を返すので middlebox/ブラウザにキャッシュさせない。
const NO_STORE = { "Cache-Control": "no-store" } as const;

export async function GET(req: NextRequest) {
  try {
    const token = await getMcpToken();
    return Response.json({ token }, { headers: NO_STORE });
  } catch (e) {
    return clientError(req, e, {
      context: "settings/mcp-token GET",
      message: "MCP トークンの取得に失敗しました (ENCRYPTION_KEY 設定を確認してください)",
    });
  }
}

export async function POST(req: NextRequest) {
  try {
    const token = await rotateMcpToken();
    return Response.json({ token }, { headers: NO_STORE });
  } catch (e) {
    return clientError(req, e, {
      context: "settings/mcp-token POST",
      message: "MCP トークンの再生成に失敗しました",
    });
  }
}
