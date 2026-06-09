/**
 * GET /api/chat/history?session=<uuid>&limit=100
 *
 * 指定 session の過去発言を時系列 (古い→新しい) で返す。
 * ChatPanel が mount 時にこれを呼んでリロード後の会話復元に使う。
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { rawMessages } from "@/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { readOverlay, clearOverlay } from "@/lib/conversation-overlay";
import { clientError } from "@/lib/api-error";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export async function GET(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session");
  if (!session) {
    return NextResponse.json({ error: "session param required" }, { status: 400 });
  }
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MAX_LIMIT)
    : DEFAULT_LIMIT;

  try {
    // 新しい順に取って limit 件 → reverse して古い→新しいで返す。
    // source=cron の user 行は内部 trigger なのでチャット履歴から除外
    // (assistant 側の応答は通常通り表示)。
    const rows = await db
      .select({
        role: rawMessages.role,
        content: rawMessages.content,
        attachments: rawMessages.attachments,
        toolSummary: rawMessages.toolSummary,
        createdAt: rawMessages.createdAt,
      })
      .from(rawMessages)
      .where(
        and(
          eq(rawMessages.sessionId, session),
          sql`NOT (${rawMessages.role} = 'user' AND ${rawMessages.source} = 'cron')`
        )
      )
      // 同 transaction で同じ created_at が振られる user/assistant ペアは
      // id (insert 順) で安定化する。
      .orderBy(desc(rawMessages.createdAt), desc(rawMessages.id))
      .limit(limit);

    // DB rows と Valkey overlay (private 会話 + ニュース/音楽の SSE 揮発) を
    // timestamp でマージ。origin タグを付けて caller (ChatPanel) が
    // LLM 文脈構築時に private を除外できるようにする。
    type Origin = "raw" | "overlay-private" | "overlay-ephemeral";
    type Merged = {
      role: "user" | "assistant";
      content: string;
      attachments?: unknown;
      toolSummary?: unknown;
      createdAt: string;
      ts: number;
      origin: Origin;
    };
    const dbMerged: Merged[] = rows.reverse().map((r) => ({
      role: r.role,
      content: r.content,
      attachments: r.attachments ?? undefined,
      toolSummary: r.toolSummary ?? undefined,
      createdAt: r.createdAt.toISOString(),
      ts: r.createdAt.getTime(),
      origin: "raw" as const,
    }));

    let overlayMerged: Merged[] = [];
    try {
      const overlay = await readOverlay(session);
      overlayMerged = overlay.map((e) => ({
        role: e.role,
        content: e.content,
        toolSummary: e.toolSummary,
        createdAt: new Date(e.ts).toISOString(),
        ts: e.ts,
        origin: e.kind === "private"
          ? ("overlay-private" as const)
          : ("overlay-ephemeral" as const),
      }));
    } catch (e) {
      console.warn("[chat/history] overlay read failed:", e);
    }

    const merged = [...dbMerged, ...overlayMerged].sort((a, b) => a.ts - b.ts);

    return NextResponse.json({
      count: merged.length,
      messages: merged.map((m) => ({
        role: m.role,
        content: m.content,
        attachments: m.attachments,
        toolSummary: m.toolSummary,
        createdAt: m.createdAt,
        origin: m.origin,
      })),
    });
  } catch (e) {
    return clientError(req, e, {
      context: "chat/history GET",
      message: "会話履歴の取得に失敗しました",
    });
  }
}

/**
 * DELETE /api/chat/history?session=<uuid>
 *
 * Valkey overlay (= プライベート会話 + SSE 由来の ephemeral 発話) を即時クリア。
 * DB の raw_messages は触らない。24h 待たずに消したいとき用 (設定 > データ から)。
 */
export async function DELETE(req: NextRequest) {
  const session = req.nextUrl.searchParams.get("session");
  if (!session) {
    return NextResponse.json({ error: "session param required" }, { status: 400 });
  }
  try {
    await clearOverlay(session);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, {
      context: "chat/history DELETE",
      message: "会話履歴のクリアに失敗しました",
    });
  }
}
