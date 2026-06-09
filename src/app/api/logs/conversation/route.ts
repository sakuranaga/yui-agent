/**
 * GET /api/logs/conversation?session=<id>&before=<ms>&from=<ms>&to=<ms>&q=<word>&limit=50
 *
 * LogModal の「会話」タブ用。
 *   - 新しい順
 *   - before: 前ページ最古 createdAt (無限スクロール用)
 *   - from/to: 期間指定 (ms epoch)
 *   - q: ワード検索 (content の部分一致, ILIKE)
 *   - session: 省略時は全 session (横断検索)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { rawMessages } from "@/db/schema";
import { and, desc, eq, lt, gte, lte, ilike, type SQL } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

function parseTs(s: string | null): Date | undefined {
  if (!s) return undefined;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? new Date(n) : undefined;
}

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session");
  const before = parseTs(req.nextUrl.searchParams.get("before"));
  const from = parseTs(req.nextUrl.searchParams.get("from"));
  const to = parseTs(req.nextUrl.searchParams.get("to"));
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;

  const conds: SQL[] = [];
  if (session) conds.push(eq(rawMessages.sessionId, session));
  if (before) conds.push(lt(rawMessages.createdAt, before));
  if (from) conds.push(gte(rawMessages.createdAt, from));
  if (to) conds.push(lte(rawMessages.createdAt, to));
  if (q && q.length > 0) conds.push(ilike(rawMessages.content, `%${q}%`));

  try {
    const rows = await db
      .select({
        id: rawMessages.id,
        sessionId: rawMessages.sessionId,
        role: rawMessages.role,
        content: rawMessages.content,
        createdAt: rawMessages.createdAt,
      })
      .from(rawMessages)
      .where(conds.length > 0 ? and(...conds) : undefined)
      // 同 transaction で同じ created_at が振られる user/assistant ペアは
      // id (insert 順) で安定化する。secondary key 無しだと並びがランダムに揺れる。
      .orderBy(desc(rawMessages.createdAt), desc(rawMessages.id))
      .limit(limit);

    return NextResponse.json({
      count: rows.length,
      messages: rows.map((r) => ({
        id: Number(r.id),
        sessionId: r.sessionId,
        role: r.role,
        content: r.content,
        createdAt: r.createdAt.toISOString(),
        ts: r.createdAt.getTime(),
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "logs/conversation", message: "会話ログの取得に失敗しました" });
  }
}
