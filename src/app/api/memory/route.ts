/**
 * GET /api/memory?type=&owner=&q=&include_invalidated=&limit=
 *   memory_chunks 一覧 (新しい順)。
 *
 * POST /api/memory
 *   body: { chunkType, owner, content, importance? }
 *   手動で記憶を追加 (actor_type='user_direct')。
 *
 * 設計: docs/memory-architecture.md §16.7 Phase 2
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { memoryChunks } from "@/db/schema";
import { and, desc, eq, ilike, isNull, type SQL } from "drizzle-orm";
import { embed } from "@/lib/embed";
import { clientError } from "@/lib/api-error";

const VALID_TYPES = new Set([
  "fact",
  "preference",
  "event",
  "emotion",
  "summary",
  "turn_summary",
  "procedural",
  "commitment",
  "task_result",
  "external_ref",
]);
const VALID_OWNERS = new Set(["user", "assistant", "shared"]);

export async function GET(req: NextRequest) {
  const type = req.nextUrl.searchParams.get("type")?.trim();
  const owner = req.nextUrl.searchParams.get("owner")?.trim();
  const q = req.nextUrl.searchParams.get("q")?.trim();
  const includeInvalidated = req.nextUrl.searchParams.get("include_invalidated") === "1";
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 500) : 100;

  const conds: SQL[] = [];
  if (type) conds.push(eq(memoryChunks.chunkType, type as never));
  if (owner) conds.push(eq(memoryChunks.owner, owner as never));
  if (!includeInvalidated) conds.push(isNull(memoryChunks.invalidatedAt));
  if (q) conds.push(ilike(memoryChunks.content, `%${q}%`));

  try {
    const rows = await db
      .select({
        id: memoryChunks.id,
        chunkType: memoryChunks.chunkType,
        owner: memoryChunks.owner,
        content: memoryChunks.content,
        importance: memoryChunks.importance,
        actorType: memoryChunks.actorType,
        createdAt: memoryChunks.createdAt,
        invalidatedAt: memoryChunks.invalidatedAt,
      })
      .from(memoryChunks)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(memoryChunks.createdAt), desc(memoryChunks.id))
      .limit(limit);

    return NextResponse.json({
      chunks: rows.map((r) => ({
        id: Number(r.id),
        chunkType: r.chunkType,
        owner: r.owner,
        content: r.content,
        importance: r.importance,
        actorType: r.actorType,
        createdAt: r.createdAt.toISOString(),
        invalidatedAt: r.invalidatedAt?.toISOString() ?? null,
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "memory", message: "記憶一覧の取得に失敗しました" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      chunkType?: string;
      owner?: string;
      content?: string;
      importance?: number;
    };
    if (!body.chunkType || !VALID_TYPES.has(body.chunkType)) {
      return NextResponse.json({ error: "invalid chunkType" }, { status: 400 });
    }
    if (!body.owner || !VALID_OWNERS.has(body.owner)) {
      return NextResponse.json({ error: "invalid owner" }, { status: 400 });
    }
    if (!body.content || body.content.trim().length === 0) {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }
    const importance =
      typeof body.importance === "number"
        ? Math.max(0, Math.min(1, body.importance))
        : 0.6;

    const [emb] = await embed([body.content]);
    const [row] = await db
      .insert(memoryChunks)
      .values({
        sessionId: null,
        chunkType: body.chunkType as never,
        owner: body.owner as never,
        content: body.content,
        embedding: emb,
        importance,
        actorType: "user_direct",
        metadata: { source: "settings_ui" },
      })
      .returning();
    return NextResponse.json({
      ok: true,
      chunk: row && {
        id: Number(row.id),
        chunkType: row.chunkType,
        owner: row.owner,
        content: row.content,
        importance: row.importance,
        actorType: row.actorType,
        createdAt: row.createdAt.toISOString(),
        invalidatedAt: row.invalidatedAt?.toISOString() ?? null,
      },
    });
  } catch (e) {
    return clientError(req, e, { context: "memory", message: "記憶の追加に失敗しました" });
  }
}
