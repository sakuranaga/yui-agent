/**
 * GET /api/logs/system?before=<ts>&from=<ts>&to=<ts>&limit=50
 *   新しい順に LLM イベントを返す。before は前ページ最古 ts (無限スクロール用)。
 *
 * DELETE /api/logs/system
 *   ログファイル truncate。clear ボタンから呼ぶ。
 */
import { NextResponse, type NextRequest } from "next/server";
import { readLlmEvents, clearLogs, getLogTotalCount } from "@/lib/llm-events-db";
import { clientError } from "@/lib/api-error";

function parseTs(s: string | null): number | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

export async function GET(req: NextRequest) {
  const before = parseTs(req.nextUrl.searchParams.get("before"));
  const from = parseTs(req.nextUrl.searchParams.get("from"));
  const to = parseTs(req.nextUrl.searchParams.get("to"));
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 50;

  try {
    const events = await readLlmEvents({ beforeTs: before, fromTs: from, toTs: to, limit });
    const totalCount = await getLogTotalCount();
    return NextResponse.json({ count: events.length, events, totalCount });
  } catch (e) {
    return clientError(req, e, { context: "logs/system", message: "システムログの取得に失敗しました" });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    await clearLogs();
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "logs/system", message: "ログの消去に失敗しました" });
  }
}
