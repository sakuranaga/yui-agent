/**
 * POST /api/tool-confirm/{token}
 *
 * Phase B: user の click を受けて、confirmed なら background で executePendingTool を起動、
 * denied なら status 書き換え + SSE で「やめておきました」を伝える。
 *
 * 認可:
 *   - cookie vroid-auth が一致 (= proxy.ts auth gate を通過した request のみ)
 *   - pending.sessionId と request の session 一致が望ましいが、本実装は単一ユーザ前提なので
 *     auth cookie 通過 = 唯一の user として扱う
 *   - pending.status === "pending" のみ受理。それ以外は 409 で既存値返す (= idempotent)
 *   - SameSite=Strict cookie 前提で CSRF 防御
 *   - body は { decision: "confirmed" | "denied" } のみ受理 (= strict validation)
 *
 * 設計: docs/tool-architecture.md §4.5 (v3 fix)
 */
import { NextResponse, type NextRequest } from "next/server";
import { cacheGet } from "@/lib/cache";
import {
  applyConfirmDecision,
  executePendingTool,
  type ConfirmPending,
} from "@/lib/tools/confirm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ token: string }> }
) {
  try {
    const { token } = await ctx.params;
    if (!/^[0-9a-f]{32}$/.test(token)) {
      return NextResponse.json({ error: "invalid token format" }, { status: 400 });
    }

    let body: { decision?: unknown; sessionId?: unknown };
    try {
      body = (await req.json()) as { decision?: unknown; sessionId?: unknown };
    } catch {
      return NextResponse.json({ error: "invalid json" }, { status: 400 });
    }
    const decision = body.decision;
    if (decision !== "confirmed" && decision !== "denied") {
      return NextResponse.json(
        { error: 'decision must be "confirmed" or "denied"' },
        { status: 400 }
      );
    }
    const claimedSessionId = typeof body.sessionId === "string" ? body.sessionId : null;
    if (!claimedSessionId) {
      return NextResponse.json({ error: "sessionId required" }, { status: 400 });
    }

    // pending 取得
    const pending = await cacheGet<ConfirmPending>(`tool-confirm:${token}`);
    if (!pending) {
      return NextResponse.json({ error: "token not found or expired" }, { status: 410 });
    }
    // session 照合: token を別 session で踏ませない (= 単一ユーザ前提でも bearer 化を避ける)
    if (pending.sessionId !== claimedSessionId) {
      return NextResponse.json({ error: "session mismatch" }, { status: 403 });
    }
    if (pending.status !== "pending") {
      // idempotent: 既に処理済なら 409 で既存 status を返す
      return NextResponse.json({ status: pending.status }, { status: 409 });
    }

    // status 書き換え
    const { status, pending: updated } = await applyConfirmDecision(token, decision);
    if (!updated) {
      return NextResponse.json({ error: "token vanished mid-flight" }, { status: 410 });
    }

    // confirmed → background で executePendingTool 起動 (= fire-and-forget)
    if (decision === "confirmed") {
      void executePendingTool(token).catch((e) => {
        console.warn(`[tool-confirm/${token}] executePendingTool failed:`, e);
      });
    }
    // denied は applyConfirmDecision 内で SSE push、実行は呼ばない (= 静かに終わる)

    return NextResponse.json({ ok: true, status }, { status: 202 });
  } catch (e) {
    return clientError(req, e, {
      context: "tool-confirm",
      message: "confirm 処理に失敗しました",
    });
  }
}
