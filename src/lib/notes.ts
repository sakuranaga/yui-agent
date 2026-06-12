/**
 * Yui ノート空間 (= 知識/メモ層) のロジック層。docs/yui-notes.md Phase N1。
 *
 * - markdown ノートの CRUD
 * - 本文を ~1000 字 chunk に分割し embed() → note_chunks に保存 (= 意味検索の本体)
 *   embed() は入力 1500 字で hard cap するため、ノート全体を 1 embedding にしない
 * - 検索は browse モード (= 検索語なし、新着順ページング) と search モード
 *   (= 検索語あり、lexical FTS ∪ semantic を融合) の 2 つ (§4)
 * - memory_chunks (= 会話記憶) とは別系統。自動 recall には混ぜない
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@/db/client";
import { notes, noteChunks, projectLinks } from "@/db/schema";
import { embed } from "@/lib/embed";

const CHUNK_CHARS = 1000; // embed() の 1500 cap 未満。日本語でも余裕を持たせる
const NOTE_SEMANTIC_WEIGHT = 0.7; // memory.ts の重みを初期値流用
const NOTE_LEXICAL_WEIGHT = 0.3;
const SEARCH_CANDIDATE_LIMIT = 50; // search モードの候補上限 (= 深いページングはしない)
const RANK_WINDOW = 50; // lexical / semantic 各 LIMIT

const VALID_SOURCES = new Set([
  "human",
  "doc_agent",
  "deep_research",
  "mcp",
  "tool_report",
  "project_note",
]);

export type NoteSource =
  | "human"
  | "doc_agent"
  | "deep_research"
  | "mcp"
  | "tool_report"
  | "project_note";

/** API 層で source パラメータの妥当性を検証するためのヘルパ。 */
export function isValidSource(s: string): boolean {
  return VALID_SOURCES.has(s);
}

export type NoteListItem = {
  id: number;
  title: string;
  preview: string; // 本文先頭 ~200 字
  source: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};

export type NoteDetail = NoteListItem & { bodyMd: string };

export type QueryResult =
  | { mode: "browse"; total: number; hasMore: boolean; notes: NoteListItem[] }
  | { mode: "search"; total: number; searchTruncated: boolean; notes: NoteListItem[] };

/** 本文を ~CHUNK_CHARS の chunk に分割 (= 行境界をなるべく尊重、長すぎる行はハードスライス)。 */
export function chunkText(body: string): string[] {
  const text = body.trim();
  if (!text) return [];
  const chunks: string[] = [];
  let buf = "";
  for (const line of text.split("\n")) {
    if (line.length > CHUNK_CHARS) {
      // 1 行が長すぎる: buf を flush してから line をスライス
      if (buf) {
        chunks.push(buf);
        buf = "";
      }
      for (let i = 0; i < line.length; i += CHUNK_CHARS) {
        chunks.push(line.slice(i, i + CHUNK_CHARS));
      }
      continue;
    }
    if (buf && buf.length + line.length + 1 > CHUNK_CHARS) {
      chunks.push(buf);
      buf = line;
    } else {
      buf = buf ? `${buf}\n${line}` : line;
    }
  }
  if (buf) chunks.push(buf);
  return chunks;
}

function deriveTitle(title: string | undefined, bodyMd: string): string {
  const t = (title ?? "").trim();
  if (t) return t.slice(0, 200);
  // 本文先頭行 (= markdown 見出しの # を除去) からタイトル生成
  const first = bodyMd.trim().split("\n")[0] ?? "";
  return first.replace(/^#+\s*/, "").trim().slice(0, 200) || "無題のメモ";
}

function preview(bodyMd: string): string {
  return bodyMd.trim().replace(/\s+/g, " ").slice(0, 200);
}

function toListItem(r: {
  id: number;
  title: string;
  body_md?: string;
  bodyMd?: string;
  source: string;
  pinned: boolean;
  archived: boolean;
  created_at?: Date | string;
  createdAt?: Date | string;
  updated_at?: Date | string;
  updatedAt?: Date | string;
}): NoteListItem {
  const body = r.body_md ?? r.bodyMd ?? "";
  const created = r.created_at ?? r.createdAt ?? new Date(0);
  const updated = r.updated_at ?? r.updatedAt ?? new Date(0);
  return {
    id: Number(r.id),
    title: r.title,
    preview: preview(body),
    source: r.source,
    pinned: r.pinned,
    archived: r.archived,
    createdAt: new Date(created).toISOString(),
    updatedAt: new Date(updated).toISOString(),
  };
}

/**
 * 本文を chunk 分割して embed → note_chunks を入れ替える。
 * **embed を先に完了させてから** transaction で「旧 delete + 新 insert」。
 * embed が失敗したら旧 chunk は残す (= 編集中に semantic 検索を失わない)。
 * 戻り値: embed/保存に成功したら true。
 */
export async function reembedNote(noteId: number, bodyMd: string): Promise<boolean> {
  try {
    const chunks = chunkText(bodyMd);
    const vectors = chunks.length ? ((await embed(chunks)) as number[][]) : [];
    await db.transaction(async (tx) => {
      await tx.delete(noteChunks).where(eq(noteChunks.noteId, noteId));
      if (chunks.length) {
        await tx.insert(noteChunks).values(
          chunks.map((content, i) => ({
            noteId,
            chunkIndex: i,
            content,
            embedding: vectors[i],
          }))
        );
      }
    });
    return true;
  } catch (e) {
    console.warn("[notes] reembed failed (本文は保存済み、chunk は据え置き):", e);
    return false;
  }
}

export async function createNote(input: {
  title?: string;
  bodyMd: string;
  source?: string;
  sourceMeta?: Record<string, unknown>;
}): Promise<NoteDetail> {
  const bodyMd = input.bodyMd ?? "";
  const source = input.source ?? "human";
  // 不正な source は silent に 'human' へ倒さず明示エラー (= 出所の取り違えを防ぐ)
  if (!VALID_SOURCES.has(source)) throw new Error(`invalid note source: ${source}`);
  const [row] = await db
    .insert(notes)
    .values({
      title: deriveTitle(input.title, bodyMd),
      bodyMd,
      source,
      sourceMeta: input.sourceMeta,
    })
    .returning();
  await reembedNote(Number(row.id), bodyMd);
  return { ...toListItem(row), bodyMd: row.bodyMd };
}

export async function updateNote(
  id: number,
  patch: {
    title?: string;
    bodyMd?: string;
    pinned?: boolean;
    archived?: boolean;
  }
): Promise<NoteDetail | null> {
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title.trim().slice(0, 200);
  if (patch.bodyMd !== undefined) set.bodyMd = patch.bodyMd;
  if (patch.pinned !== undefined) set.pinned = patch.pinned;
  if (patch.archived !== undefined) set.archived = patch.archived;
  // title 未指定 + body 変更時はタイトルを再導出 (= 空タイトルのまま放置しない)
  if (patch.title === undefined && patch.bodyMd !== undefined) {
    set.title = deriveTitle(undefined, patch.bodyMd);
  }

  const [row] = await db.update(notes).set(set).where(eq(notes.id, id)).returning();
  if (!row) return null;
  if (patch.bodyMd !== undefined) await reembedNote(id, patch.bodyMd);
  return { ...toListItem(row), bodyMd: row.bodyMd };
}

export async function getNote(id: number): Promise<NoteDetail | null> {
  const [row] = await db.select().from(notes).where(eq(notes.id, id)).limit(1);
  if (!row) return null;
  return { ...toListItem(row), bodyMd: row.bodyMd };
}

/**
 * 物理削除 (= note_chunks は FK CASCADE で自動削除)。添付は Phase N4。
 * project_links はポリモーフィックで FK が無いので、同一 transaction で memo link を
 * 明示削除して orphan を防ぐ (§14.2)。
 */
export async function deleteNote(id: number): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const res = await tx.delete(notes).where(eq(notes.id, id)).returning({ id: notes.id });
    if (res.length === 0) return false;
    await tx
      .delete(projectLinks)
      .where(and(eq(projectLinks.artifactType, "memo"), eq(projectLinks.artifactId, String(id))));
    return true;
  });
}

function sourceFilterOk(source?: string): string | null {
  return source && VALID_SOURCES.has(source) ? source : null;
}

/** NaN / 小数 / 範囲外を既定値 + クランプで安全な整数に。 */
function clampInt(v: number | undefined, def: number, min: number, max: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.floor(v) : def;
  return Math.min(max, Math.max(min, n));
}

/** browse モード: 検索語なし。created_at 降順 (+ pinned 優先) で offset ページング。 */
async function browseNotes(opts: {
  source?: string;
  includeArchived: boolean;
  limit: number;
  offset: number;
}): Promise<QueryResult> {
  const conds = [];
  if (!opts.includeArchived) conds.push(eq(notes.archived, false));
  const src = sourceFilterOk(opts.source);
  if (src) conds.push(eq(notes.source, src));
  const where = conds.length ? and(...conds) : undefined;

  const [{ total }] = await db.select({ total: sql<number>`count(*)::int` }).from(notes).where(where);
  const rows = await db
    .select()
    .from(notes)
    .where(where)
    .orderBy(desc(notes.pinned), desc(notes.createdAt))
    .limit(opts.limit)
    .offset(opts.offset);

  return {
    mode: "browse",
    total,
    hasMore: opts.offset + rows.length < total,
    notes: rows.map(toListItem),
  };
}

/** search モード: 検索語あり。lexical FTS ∪ semantic (note_chunks) を融合。 */
async function searchNotesMode(opts: {
  query: string;
  source?: string;
  includeArchived: boolean;
  limit: number;
  offset: number;
}): Promise<QueryResult> {
  const q = opts.query;
  const src = sourceFilterOk(opts.source);
  const qVec = (await embed(q)) as number[];
  const vecLit = `[${qVec.join(",")}]`;

  // フィルタは両 CTE の WHERE に入れる (= HNSW LIMIT の前に適用、検索漏れ防止)
  const archCond = opts.includeArchived ? sql`` : sql`AND NOT n.archived`;
  const srcCond = src ? sql`AND n.source = ${src}` : sql``;

  const result = await db.execute(sql`
    WITH sem_chunks AS (
      SELECT nc.note_id, (1 - (nc.embedding <=> ${vecLit}::vector)) AS sim
      FROM note_chunks nc
      JOIN notes n ON n.id = nc.note_id
      WHERE TRUE ${archCond} ${srcCond}
      ORDER BY nc.embedding <=> ${vecLit}::vector
      LIMIT ${RANK_WINDOW}
    ),
    semantic AS (
      SELECT note_id, MAX(sim) AS sim FROM sem_chunks GROUP BY note_id
    ),
    lexical AS (
      SELECT n.id AS note_id,
             ts_rank(to_tsvector('simple', coalesce(n.title,'') || ' ' || n.body_md),
                     plainto_tsquery('simple', ${q})) AS bm25
      FROM notes n
      WHERE TRUE ${archCond} ${srcCond}
        AND to_tsvector('simple', coalesce(n.title,'') || ' ' || n.body_md)
            @@ plainto_tsquery('simple', ${q})
      ORDER BY bm25 DESC
      LIMIT ${RANK_WINDOW}
    )
    SELECT n.id, n.title, n.body_md, n.source, n.pinned, n.archived,
           n.created_at, n.updated_at,
           COALESCE(s.sim, 0)::real AS sim,
           COALESCE(l.bm25, 0)::real AS bm25
    FROM notes n
    LEFT JOIN semantic s ON n.id = s.note_id
    LEFT JOIN lexical  l ON n.id = l.note_id
    WHERE s.note_id IS NOT NULL OR l.note_id IS NOT NULL
  `);

  const rows = result as unknown as Array<Record<string, unknown>>;
  const list = rows.map((r) => ({
    item: toListItem(r as never),
    score: Number(r.sim) * NOTE_SEMANTIC_WEIGHT + Number(r.bm25) * NOTE_LEXICAL_WEIGHT,
  }));
  list.sort((a, b) => b.score - a.score);

  const total = list.length; // lexical ∪ semantic にヒットした distinct note 件数
  // 候補は上位 candidateLimit=50 件まで。その範囲内で offset/limit ページング (§4.2)。
  const top = list.slice(0, SEARCH_CANDIDATE_LIMIT);
  const offset = clampInt(opts.offset, 0, 0, SEARCH_CANDIDATE_LIMIT);
  const limit = clampInt(opts.limit, SEARCH_CANDIDATE_LIMIT, 1, SEARCH_CANDIDATE_LIMIT);
  return {
    mode: "search",
    total,
    searchTruncated: total > SEARCH_CANDIDATE_LIMIT,
    notes: top.slice(offset, offset + limit).map((x) => x.item),
  };
}

/**
 * ノート検索のエントリポイント。query が空なら browse、あれば search (§4)。
 * limit/offset は NaN/範囲外をクランプ。includeArchived で archived も含められる。
 */
export async function queryNotes(opts: {
  query?: string;
  source?: string;
  includeArchived?: boolean;
  limit?: number;
  offset?: number;
}): Promise<QueryResult> {
  const query = (opts.query ?? "").trim();
  const includeArchived = opts.includeArchived ?? false;
  if (!query) {
    const limit = clampInt(opts.limit, 100, 1, 200);
    const offset = clampInt(opts.offset, 0, 0, Number.MAX_SAFE_INTEGER);
    return browseNotes({ source: opts.source, includeArchived, limit, offset });
  }
  return searchNotesMode({
    query,
    source: opts.source,
    includeArchived,
    limit: clampInt(opts.limit, SEARCH_CANDIDATE_LIMIT, 1, SEARCH_CANDIDATE_LIMIT),
    offset: clampInt(opts.offset, 0, 0, SEARCH_CANDIDATE_LIMIT),
  });
}
