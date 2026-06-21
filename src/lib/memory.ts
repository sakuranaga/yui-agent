/**
 * Phase 1 memory layer.
 * - writeRawMessage: 毎ターン raw 保存
 * - retrieveRelevant: クエリ embed → semantic search → system prompt 用に整形
 *
 * 詳細は docs/memory-architecture.md §4 (検索) / §5 (書き込み) 参照。
 */
import { db, sql } from "@/db/client";
import { rawMessages, retrievalLog, type NewRawMessage } from "@/db/schema";
import { embed, toPgVector } from "@/lib/embed";
import { relativeJST } from "@/lib/time";
import { addXp } from "@/lib/xp";

export type RetrievedChunk = {
  id: number;
  content: string;
  chunkType: string;
  importance: number;
  createdAt: Date;
  actorType: string;
  sourceSystem: string | null;
  sourceId: string | null;
  score: number;
};

const TAU_DAYS = 30; // 時間減衰の半減期目安
const SEMANTIC_WEIGHT = 0.7;
const LEXICAL_WEIGHT = 0.3;
const MMR_LAMBDA = 0.5; // 関連性 vs 多様性のバランス

/** pgvector の文字列表現 '[0.1,0.2,...]' を number[] にパース */
function parsePgVector(s: string): number[] {
  return s
    .slice(1, -1)
    .split(",")
    .map((x) => parseFloat(x));
}

function cosineSim(a: number[], b: number[]): number {
  let dot = 0,
    na = 0,
    nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na * nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Maximal Marginal Relevance: 関連スコアが高くかつ既選択と重複しないものを選ぶ。
 * lambda が大きいほど関連性重視、小さいほど多様性重視。
 */
function mmrSelect<
  T extends { id: number; score: number; embedding: number[] | null },
>(candidates: T[], k: number, lambda = MMR_LAMBDA): T[] {
  const selected: T[] = [];
  const remaining = [...candidates];
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      let maxSim = 0;
      if (selected.length > 0 && c.embedding) {
        for (const s of selected) {
          if (!s.embedding) continue;
          const sim = cosineSim(c.embedding, s.embedding);
          if (sim > maxSim) maxSim = sim;
        }
      }
      const mmr = lambda * c.score - (1 - lambda) * maxSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}

/**
 * 直近 N=2 user turn と現在の発話を連結して埋め込み用クエリを作る。
 * 「あれ」「さっき」のような参照詞で検索が空振りするのを防ぐ。
 */
export function buildQueryText(
  history: { role: "user" | "assistant"; content: string }[],
  currentUserMsg: string
): string {
  const lastUserTurns = history
    .filter((m) => m.role === "user")
    .slice(-2)
    .map((m) => m.content);
  return [...lastUserTurns, currentUserMsg].join("\n");
}

/**
 * 直近2 user turn + 今のuser発話を embed して memory_chunks をハイブリッド検索。
 * invalidated_at IS NULL なものだけ。
 *
 * 設計変更 (2026-05): 「現セッションを除外」を撤回。理由はページリロードで
 * messages[] が空になっても sessionId は localStorage に残り続けるため、
 * 同セッション内の過去抽出データが retrieval から除外されて見えなくなる
 * 問題が発生していた。memory_chunks は要約形なので L5 (verbatim) と重複しない。
 *
 * 戻り値は最終スコア降順、最大 limit 件。
 */
export async function retrieveRelevant(opts: {
  queryText: string;
  currentSessionId: string;
  limit?: number;
  excludeIds?: number[];
}): Promise<RetrievedChunk[]> {
  const { queryText } = opts;
  const limit = opts.limit ?? 5;
  const excludeIds = opts.excludeIds ?? [];

  // 1. embed query
  let queryVec: number[];
  try {
    queryVec = await embed(queryText);
  } catch (e) {
    console.warn("[memory] embed failed, skipping retrieval:", e);
    return [];
  }
  const vecLit = toPgVector(queryVec);

  // 2. hybrid search. LIMIT 30 で取って JS で MMR と時間減衰スコアリング。
  // embedding カラムも返してもらう (MMR で類似度判定に使う)。
  const rows = await sql<
    Array<{
      id: number;
      content: string;
      chunk_type: string;
      importance: number;
      created_at: Date;
      actor_type: string;
      source_system: string | null;
      source_id: string | null;
      embedding: string;
      sim: number;
      bm25: number;
    }>
  >`
    WITH semantic AS (
      SELECT id, 1 - (embedding <=> ${vecLit}::vector) AS sim
      FROM memory_chunks
      WHERE chunk_type IN (
              'fact','preference','event','emotion','summary',
              'turn_summary','procedural','external_ref',
              'commitment','task_result'
            )
        AND invalidated_at IS NULL
        AND embedding IS NOT NULL
        AND id != ALL(${excludeIds}::bigint[])
      ORDER BY embedding <=> ${vecLit}::vector
      LIMIT 30
    ),
    lexical AS (
      SELECT id,
             ts_rank(to_tsvector('simple', content),
                     plainto_tsquery('simple', ${queryText})) AS bm25
      FROM memory_chunks
      WHERE to_tsvector('simple', content) @@ plainto_tsquery('simple', ${queryText})
        AND invalidated_at IS NULL
        AND id != ALL(${excludeIds}::bigint[])
      LIMIT 30
    )
    SELECT m.id, m.content, m.chunk_type, m.importance, m.created_at,
           m.actor_type, m.source_system, m.source_id,
           m.embedding::text AS embedding,
           COALESCE(s.sim, 0)::real  AS sim,
           COALESCE(l.bm25, 0)::real AS bm25
    FROM memory_chunks m
    LEFT JOIN semantic s ON m.id = s.id
    LEFT JOIN lexical  l ON m.id = l.id
    WHERE s.id IS NOT NULL OR l.id IS NOT NULL
  `;

  // 3. スコアリング (時間減衰 + importance boost)
  const now = Date.now();
  const scored = rows.map((r) => {
    const ageDays = (now - new Date(r.created_at).getTime()) / 86_400_000;
    const decay = Math.exp(-ageDays / TAU_DAYS);
    const base = (r.sim * SEMANTIC_WEIGHT + r.bm25 * LEXICAL_WEIGHT) * decay;
    const score = base * (1 + r.importance);
    return {
      id: r.id,
      content: r.content,
      chunkType: r.chunk_type,
      importance: r.importance,
      createdAt: new Date(r.created_at),
      actorType: r.actor_type,
      sourceSystem: r.source_system,
      sourceId: r.source_id,
      embedding: r.embedding ? parsePgVector(r.embedding) : null,
      score,
    };
  });

  // 4. score降順にソートしてから MMR で多様性ありの top-K に絞る
  scored.sort((a, b) => b.score - a.score);
  const selected = mmrSelect(scored, limit, MMR_LAMBDA);

  // 5. retrieval_log に記録 (fire-and-forget、wall latency に影響させない)
  void logRetrieval({
    hits: selected.map((s) => ({ id: s.id, score: s.score })),
    sessionId: opts.currentSessionId,
    layer: "l4_semantic",
  });

  // embedding は外向き型から落とす (caller には不要)
  return selected.map(({ embedding: _e, ...rest }) => rest);
}

/**
 * L2: 常時 system prompt に注入する "重要事実"。
 * importance 上位の fact / preference / procedural / external_ref を返す。
 * クエリ非依存 (毎ターン同じものが取れる)。
 */
export async function loadAlwaysOnFacts(opts: {
  limit?: number;
  excludeIds?: number[];
  sessionId?: string;
}): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 10;
  const excludeIds = opts.excludeIds ?? [];
  const rows = await sql<
    Array<{
      id: number;
      content: string;
      chunk_type: string;
      importance: number;
      created_at: Date;
      actor_type: string;
      source_system: string | null;
      source_id: string | null;
    }>
  >`
    SELECT id, content, chunk_type, importance, created_at,
           actor_type, source_system, source_id
    FROM memory_chunks
    WHERE chunk_type IN ('fact','preference','procedural','external_ref')
      AND invalidated_at IS NULL
      AND importance >= 0.5
      AND id != ALL(${excludeIds}::bigint[])
    ORDER BY importance DESC, created_at DESC
    LIMIT ${limit}
  `;
  const result = rows.map((r) => ({
    id: r.id,
    content: r.content,
    chunkType: r.chunk_type,
    importance: r.importance,
    createdAt: new Date(r.created_at),
    actorType: r.actor_type,
    sourceSystem: r.source_system,
    sourceId: r.source_id,
    score: r.importance,
  }));
  void logRetrieval({
    hits: result.map((r) => ({ id: r.id, score: r.importance })),
    sessionId: opts.sessionId,
    layer: "l2_facts",
  });
  return result;
}

/**
 * L3: 直近の summary chunk (= 過去セッションの要約) を最新順に返す。
 */
export async function loadRecentSummaries(opts: {
  limit?: number;
  excludeIds?: number[];
  sessionId?: string;
}): Promise<RetrievedChunk[]> {
  const limit = opts.limit ?? 3;
  const excludeIds = opts.excludeIds ?? [];
  const rows = await sql<
    Array<{
      id: number;
      content: string;
      chunk_type: string;
      importance: number;
      created_at: Date;
      actor_type: string;
      source_system: string | null;
      source_id: string | null;
    }>
  >`
    SELECT id, content, chunk_type, importance, created_at,
           actor_type, source_system, source_id
    FROM memory_chunks
    WHERE chunk_type IN ('summary','turn_summary')
      AND invalidated_at IS NULL
      AND id != ALL(${excludeIds}::bigint[])
    ORDER BY created_at DESC
    LIMIT ${limit}
  `;
  const result = rows.map((r) => ({
    id: r.id,
    content: r.content,
    chunkType: r.chunk_type,
    importance: r.importance,
    createdAt: new Date(r.created_at),
    actorType: r.actor_type,
    sourceSystem: r.source_system,
    sourceId: r.source_id,
    score: 1,
  }));
  void logRetrieval({
    hits: result.map((r) => ({ id: r.id, score: r.importance })),
    sessionId: opts.sessionId,
    layer: "l3_summary",
  });
  return result;
}

/**
 * 与えた embedding に対して semantic に近い memory_chunks を返す。
 * 矛盾解決 (reconcile) で使う。
 */
export async function findSimilarChunks(opts: {
  embedding: number[];
  excludeIds?: number[];
  minSim?: number;
  limit?: number;
  sameTypeAs?: string;
  sameOwnerAs?: string;
}): Promise<RetrievedChunk[]> {
  const minSim = opts.minSim ?? 0.7;
  const limit = opts.limit ?? 5;
  const vecLit = toPgVector(opts.embedding);
  const excludeIds = opts.excludeIds ?? [];
  const sameTypeAs = opts.sameTypeAs ?? null;
  const sameOwnerAs = opts.sameOwnerAs ?? null;

  const rows = await sql<
    Array<{
      id: number;
      content: string;
      chunk_type: string;
      importance: number;
      created_at: Date;
      actor_type: string;
      source_system: string | null;
      source_id: string | null;
      sim: number;
    }>
  >`
    SELECT id, content, chunk_type, importance, created_at,
           actor_type, source_system, source_id,
           (1 - (embedding <=> ${vecLit}::vector))::real AS sim
    FROM memory_chunks
    WHERE invalidated_at IS NULL
      AND embedding IS NOT NULL
      AND id != ALL(${excludeIds}::bigint[])
      AND (${sameTypeAs}::text IS NULL OR chunk_type = ${sameTypeAs})
      AND (${sameOwnerAs}::text IS NULL OR owner = ${sameOwnerAs})
      AND (1 - (embedding <=> ${vecLit}::vector)) >= ${minSim}
    ORDER BY embedding <=> ${vecLit}::vector
    LIMIT ${limit}
  `;

  return rows.map((r) => ({
    id: r.id,
    content: r.content,
    chunkType: r.chunk_type,
    importance: r.importance,
    createdAt: new Date(r.created_at),
    actorType: r.actor_type,
    sourceSystem: r.source_system,
    sourceId: r.source_id,
    score: r.sim,
  }));
}

/**
 * retrieval_log への append-only 記録。fire-and-forget で呼ぶこと
 * (失敗しても retrieval 本体には影響させない)。
 *
 * layer 別:
 *   - "l2_facts"      : loadAlwaysOnFacts
 *   - "l3_summary"    : loadRecentSummaries
 *   - "l4_semantic"   : retrieveRelevant
 *   - "reconcile"     : findSimilarChunks (reconcile context)
 *   - "extract_dedup" : findSimilarChunks (extract dedup, future)
 *
 * 設計: docs/memory-architecture.md §16.7 Phase 5
 */
export async function logRetrieval(opts: {
  hits: Array<{ id: number; score?: number }>;
  sessionId?: string;
  layer: "l2_facts" | "l3_summary" | "l4_semantic" | "reconcile" | "extract_dedup";
}): Promise<void> {
  if (opts.hits.length === 0) return;
  try {
    const values = opts.hits.map((h, i) => ({
      chunkId: h.id,
      sessionId: opts.sessionId,
      layer: opts.layer,
      rank: i,
      score: h.score ?? null,
    }));
    await db.insert(retrievalLog).values(values);
  } catch (e) {
    console.warn(`[memory] retrieval_log insert failed (layer=${opts.layer}):`, e);
  }
}

/**
 * 既存 chunk の importance をブースト (再強化、上限 1.0)。
 * extract-time の重複検出で使う:「同じ事実が再度言及された = importance を上げる」。
 * metadata.reinforced_at と reinforce_count を記録する。
 */
export async function boostImportance(opts: {
  chunkId: number;
  delta?: number;
}): Promise<void> {
  const delta = opts.delta ?? 0.05;
  await sql`
    UPDATE memory_chunks
    SET importance = LEAST(1.0, importance + ${delta}),
        metadata = COALESCE(metadata, '{}'::jsonb)
          || jsonb_build_object(
            'reinforced_at', NOW()::text,
            'reinforce_count', COALESCE((metadata->>'reinforce_count')::int, 0) + 1
          )
    WHERE id = ${opts.chunkId}
      AND invalidated_at IS NULL
  `;
}

/**
 * chunk を invalidate (削除はせず、retrieval から見えなくする)。
 * 監査トレイルとして reason と invalidatedByChunkId を metadata に追加。
 */
export async function invalidateChunk(opts: {
  chunkId: number;
  reason: string;
  invalidatedByChunkId?: number;
}): Promise<void> {
  await sql`
    UPDATE memory_chunks
    SET invalidated_at = NOW(),
        metadata = COALESCE(metadata, '{}'::jsonb) || ${JSON.stringify({
          invalidation_reason: opts.reason,
          invalidated_by_chunk_id: opts.invalidatedByChunkId ?? null,
        })}::jsonb
    WHERE id = ${opts.chunkId}
      AND invalidated_at IS NULL
  `;
}

/**
 * raw_messages に1ペア (user + assistant) を保存。失敗してもchat全体を
 * 止めない (caller側で fire-and-forget で呼ぶこと)。
 */
export async function writeRawTurnPair(opts: {
  sessionId: string;
  source: "web" | "discord_text" | "discord_voice" | "cron" | "timer" | "tool_confirm_result";
  userMsg: string;
  assistantMsg: string;
  emotion?: string;
  /** user 行に紐づく添付ファイル参照。ファイル本体は chat-attachments.saveImage で別途保存済み。 */
  userAttachments?: Array<{ filename: string; mediaType: string }>;
  /** assistant 行にひもづく、このターンで実行した tool 呼び出し要約 */
  assistantToolSummary?: Array<{ name: string; brief: string }>;
}): Promise<void> {
  const rows: NewRawMessage[] = [
    {
      sessionId: opts.sessionId,
      role: "user",
      content: opts.userMsg,
      source: opts.source,
      attachments: opts.userAttachments ?? [],
    },
    {
      sessionId: opts.sessionId,
      role: "assistant",
      content: opts.assistantMsg,
      emotion: opts.emotion,
      source: opts.source,
      toolSummary: opts.assistantToolSummary ?? [],
    },
  ];
  const inserted = await db.insert(rawMessages).values(rows).returning({ id: rawMessages.id, role: rawMessages.role });
  // user 発話 1 件 = chat_turn +1 XP。refTable/refId で 1 ターン 1 加算を保証
  const userRow = inserted.find((r) => r.role === "user");
  if (userRow) {
    void addXp({
      eventType: "chat_turn",
      refTable: "raw_messages",
      refId: userRow.id,
    });
  }
}

/**
 * assistant 単発メッセージを raw_messages に保存。
 * specialist の voice formatter 結果や timer 発火時の Yui voice 等、
 * 主ターン外で生成される追加発話を会話履歴に残すため。
 * 失敗しても呼び出し元を止めない (fire-and-forget OK)。
 */
export async function writeAssistantMessage(opts: {
  sessionId: string;
  source: "web" | "discord_text" | "discord_voice" | "cron" | "timer" | "tool_confirm_result";
  content: string;
  emotion?: string;
  toolSummary?: Array<{ name: string; brief: string }>;
}): Promise<void> {
  await db.insert(rawMessages).values({
    sessionId: opts.sessionId,
    role: "assistant",
    content: opts.content,
    emotion: opts.emotion,
    source: opts.source,
    toolSummary: opts.toolSummary ?? [],
  });
}

/** 時間情報を併記すべき chunk_type */
const TIME_PREFIX_TYPES = new Set([
  "event",
  "summary",
  "turn_summary",
  "emotion",
  "task_result",
]);

/**
 * retrieved chunks を chunk_type ごとにグルーピングしてラベル付きで整形。
 * event / summary / emotion / task_result は相対時刻を冒頭に付ける。
 */
function formatChunkGroup(chunks: RetrievedChunk[], now: Date): string {
  const byType = new Map<string, RetrievedChunk[]>();
  for (const c of chunks) {
    const arr = byType.get(c.chunkType) ?? [];
    arr.push(c);
    byType.set(c.chunkType, arr);
  }

  const labels: Record<string, string> = {
    fact: "事実",
    preference: "好み",
    event: "出来事",
    emotion: "感情パターン",
    summary: "セッション要約",
    turn_summary: "会話の途中要約",
    procedural: "ルーチン",
    commitment: "結衣の約束",
    task_result: "サブエージェントの結果",
    external_ref: "外部システム情報",
  };

  return Array.from(byType.entries())
    .map(([type, items]) => {
      const label = labels[type] ?? type;
      const showTime = TIME_PREFIX_TYPES.has(type);
      const lines = items
        .map((c) => {
          if (showTime) {
            const when = relativeJST(c.createdAt, now);
            return `- (${when}) ${c.content}`;
          }
          return `- ${c.content}`;
        })
        .join("\n");
      return `[${label}]\n${lines}`;
    })
    .join("\n\n");
}

/**
 * L2 / L3 / L4 をまとめて "結衣の記憶" セクションに整形する。
 * 各層を見出し付きで分けて Claude に区別させる。
 */
export function formatMemoryPrompt(opts: {
  alwaysOnFacts: RetrievedChunk[];
  recentSummaries: RetrievedChunk[];
  relevantChunks: RetrievedChunk[];
  now?: Date;
}): string {
  const now = opts.now ?? new Date();
  const sections: string[] = [];

  if (opts.alwaysOnFacts.length > 0) {
    sections.push(
      [
        "### ご主人様について大切なこと (常時の記憶)",
        formatChunkGroup(opts.alwaysOnFacts, now),
      ].join("\n\n")
    );
  }

  if (opts.recentSummaries.length > 0) {
    const lines = opts.recentSummaries.map(
      (c) => `- (${relativeJST(c.createdAt, now)}) ${c.content}`
    );
    sections.push(
      ["### 最近のお話 (直近のセッション要約)", lines.join("\n")].join("\n\n")
    );
  }

  if (opts.relevantChunks.length > 0) {
    sections.push(
      [
        "### 今の話題に関連する記憶",
        formatChunkGroup(opts.relevantChunks, now),
      ].join("\n\n")
    );
  }

  if (sections.length === 0) return "";

  return [
    "## 結衣の記憶",
    "",
    ...sections,
    "",
    "これらは会話の参考までに。明示的に話題に出すかは文脈次第 (全部披露しない)。",
  ].join("\n\n");
}
