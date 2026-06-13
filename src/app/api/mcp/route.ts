/**
 * ゆい MCP サーバ エンドポイント (docs/yui-mcp-server.md §3/§4)。
 *
 * - Streamable HTTP の MCP サーバを mcp-handler 経由で /api/mcp にマウント。
 * - 認証は自前ゲート (Bearer token + Origin/Host) で行い、固定文 401/403 を返す
 *   (= CLAUDE.md 準拠で生エラーを漏らさない)。OK なら mcp-handler に委譲。
 * - cookie 認証は持たない CLI が叩くので proxy.ts の PUBLIC_PATHS に /api/mcp を追加し、
 *   ここで必ず Bearer 検証する (= 無認証では晒さない)。
 */
import { createMcpHandler } from "mcp-handler";
import { verifyMcpToken } from "@/lib/mcp-token";
import { registerNoteTools } from "@/lib/mcp/tools-note";
import { registerTodoTools } from "@/lib/mcp/tools-todo";
import { registerReminderTools } from "@/lib/mcp/tools-reminder";
import { registerNotifyTools } from "@/lib/mcp/tools-notify";

export const runtime = "nodejs";

const mcpHandler = createMcpHandler(
  (server) => {
    registerNoteTools(server);
    registerTodoTools(server);
    registerReminderTools(server);
    registerNotifyTools(server);
  },
  {},
  {
    // mcp-handler は streamableHttpEndpoint = `${basePath}/mcp` を pathname 完全一致で
    // ルーティングする (dist deriveEndpointsFromBasePath)。この route は /api/mcp を
    // serve するので basePath は "/api" にして endpoint を /api/mcp に一致させる
    // (basePath "/api/mcp" だと /api/mcp/mcp を期待され Not found になる)。
    basePath: "/api",
    // SSE 再開用 redis (任意)。未設定なら非再開モードで動く。
    redisUrl: process.env.VALKEY_URL ?? process.env.REDIS_URL,
  }
);

let warnedNoAllowlist = false;

/**
 * 許可ホスト一覧。`MCP_ALLOWED_HOSTS` (カンマ区切り) で明示時のみ Host/Origin を強制する。
 * 未設定なら Bearer のみで守る (= プロジェクトに canonical な base-URL env が無く、Tailscale 等で
 * アクセス host が可変なため。**Bearer トークンが第一防御で、悪意サイトはトークンを持たず 401**
 * になるので DNS rebinding も実質防げる。Host allowlist は任意の belt-and-suspenders)。
 * 未設定時は 1 回だけ推奨ログを出す。
 */
function allowedHosts(): string[] | null {
  const raw = process.env.MCP_ALLOWED_HOSTS?.trim();
  if (!raw) {
    if (!warnedNoAllowlist) {
      warnedNoAllowlist = true;
      console.warn(
        "[mcp] MCP_ALLOWED_HOSTS 未設定: Origin/Host 検証は無効 (Bearer のみで保護)。" +
          "厳格運用するなら許可ホストを env に設定してください。"
      );
    }
    return null;
  }
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** DNS rebinding 対策: Origin があれば許可ホストと照合、Host は許可リスト設定時のみ強制。 */
function originHostOk(req: Request): boolean {
  const allow = allowedHosts();
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const oh = new URL(origin).host.toLowerCase();
      if (allow && !allow.includes(oh)) return false;
    } catch {
      return false; // 壊れた Origin は拒否
    }
  }
  if (allow) {
    const host = (req.headers.get("host") ?? "").toLowerCase();
    if (!allow.includes(host)) return false;
  }
  return true;
}

function bearerFrom(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

function deny(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function gate(req: Request): Promise<Response> {
  if (!originHostOk(req)) return deny(403, "forbidden");
  if (!(await verifyMcpToken(bearerFrom(req)))) return deny(401, "unauthorized");
  return mcpHandler(req);
}

export { gate as GET, gate as POST, gate as DELETE };
