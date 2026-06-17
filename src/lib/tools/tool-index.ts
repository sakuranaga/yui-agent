/**
 * tool_index の build / reindex (docs/tool-dispatch-redesign.md §12.2 / §12.4)。
 *
 * 各ツールの「description (1) + 例文 (N)」を embed して tool_index に投入する。
 * atomic 再構築: 新しい index_version で全行を作り切ってから tool_index_meta の
 * active_tool_index_version を切り替え、旧 version を削除する (Codex Medium: 旧
 * version を残すと HNSW recall が劣化するため build の最後に掃除)。
 *
 * embed モデル変更時もこの再 build で対応 (= ベクトルは text の導出物)。
 */
import { randomUUID } from "node:crypto";
import { db, sql as rawSql } from "@/db/client"; // rawSql = postgres-js tagged template (生クエリ用)
import { eq, ne, sql } from "drizzle-orm"; // sql = drizzle (tx.execute 用)
import { toolIndex, toolIndexMeta, type NewToolIndexRow } from "@/db/schema";
import { embed, toPgVector } from "@/lib/embed";
import { getEmbedConfig } from "@/lib/ai-settings";
import { ALL_TOOLS } from "@/lib/tools/registry";
import { TOOL_EXAMPLES } from "@/lib/tools/tool-examples";
import type { ToolDef } from "@/lib/tools/types";

export const ACTIVE_VERSION_KEY = "active_tool_index_version";

const EMBED_BATCH = 64; // embed() に一度に渡す件数 (短文なので 64 で十分)
const INSERT_CHUNK = 100;

// 常時候補に含める高頻度コアツール (§12.2、≤6 の具体名 allowlist)。
// retrieval が外しても最低限カバーする floor (permitted ∩ で適用)。
const FLOOR_TOOLS = [
  "web_search",
  "create_timer",
  "add_todo",
  "add_reminder",
  "gcal_create_event",
  "gcal_list_events",
];
const RRF_K = 60; // Reciprocal Rank Fusion の定数 (標準値)
const DEFAULT_TOP_K = 10;

type IndexItem = { toolName: string; kind: "example" | "description"; text: string };

/** ALL_TOOLS + TOOL_EXAMPLES から (tool, kind, text) を列挙 (重複は事前 dedup)。 */
function collectItems(): IndexItem[] {
  const items: IndexItem[] = [];
  const seen = new Set<string>();
  const add = (toolName: string, kind: IndexItem["kind"], raw: string) => {
    const text = raw.trim();
    if (!text) return;
    const key = JSON.stringify([toolName, kind, text]);
    if (seen.has(key)) return; // UNIQUE(tool,kind,md5(text),version) 違反を未然に防ぐ
    seen.add(key);
    items.push({ toolName, kind, text });
  };
  for (const t of ALL_TOOLS) {
    add(t.name, "description", t.description ?? "");
    for (const ex of TOOL_EXAMPLES[t.name] ?? []) add(t.name, "example", ex);
  }
  return items;
}

/**
 * tool_index を再 build する。返り値 = { version, rows }。
 * 失敗時は例外を投げる。DB 書き込みは 1 transaction なので途中失敗は rollback され
 * 新 version 行は残らない (active も切り替わらない)。embed 失敗時は DB 未変更。
 * いずれも検索側は旧 active を使い続ける = 安全。
 */
export async function buildToolIndex(): Promise<{ version: string; rows: number }> {
  const cfg = await getEmbedConfig();
  const version = `v${Date.now()}-${randomUUID()}`; // 同一 ms の並行 build 衝突を防ぐ
  const items = collectItems();
  if (items.length === 0) throw new Error("tool_index: 投入対象が空 (ALL_TOOLS / TOOL_EXAMPLES を確認)");

  // 1. 全 text を batch embed
  const vectors: number[][] = [];
  for (let i = 0; i < items.length; i += EMBED_BATCH) {
    const batch = items.slice(i, i + EMBED_BATCH).map((x) => x.text);
    const vs = (await embed(batch)) as number[][];
    vectors.push(...vs);
  }
  if (vectors.length !== items.length) {
    throw new Error(`tool_index: embed 件数不一致 (items=${items.length} vectors=${vectors.length})`);
  }

  const rows: NewToolIndexRow[] = items.map((it, i) => ({
    toolName: it.toolName,
    kind: it.kind,
    text: it.text,
    embedding: vectors[i],
    embeddingModel: cfg.model,
    embeddingDimensions: cfg.dimensions,
    indexVersion: version,
  }));

  // 2-4. DB 書き込み (insert → active 切替 → 旧 version 削除) は 1 transaction +
  // advisory lock で直列化する (Codex High: 並行 build が互いの active version 行を
  // 消す競合を防ぐ)。embed は txn 外なので並行 build も embed までは並走可。txn 内なので
  // 途中失敗は rollback され、未 active の orphan 行も残らない (recall 劣化防止 §12.4)。
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('tool_index_build'))`);
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
      await tx.insert(toolIndex).values(rows.slice(i, i + INSERT_CHUNK));
    }
    await tx
      .insert(toolIndexMeta)
      .values({ key: ACTIVE_VERSION_KEY, value: version })
      .onConflictDoUpdate({
        target: toolIndexMeta.key,
        set: { value: version, updatedAt: new Date() },
      });
    await tx.delete(toolIndex).where(ne(toolIndex.indexVersion, version));
  });

  return { version, rows: rows.length };
}

/** 現在の active index_version を返す (未 build なら null = full catalog fallback)。 */
export async function getActiveToolIndexVersion(): Promise<string | null> {
  const rows = await db
    .select({ value: toolIndexMeta.value })
    .from(toolIndexMeta)
    .where(eq(toolIndexMeta.key, ACTIVE_VERSION_KEY))
    .limit(1);
  return rows[0]?.value ?? null;
}

export type ToolRetrievalMode = "hybrid" | "lexical-only" | "full-catalog";
export type ToolRetrieval = { toolNames: string[]; mode: ToolRetrievalMode };

/**
 * Executor #2 に渡すツール候補を絞り込む (§12.2)。
 *
 * dense (pgvector cosine) + lexical (PGroonga 日本語全文検索) を別々に top-K 取り
 * **RRF (1/(k+rank))** で融合。候補 = `floor ∪ RRF-topK ∪ dependentReads` (∩ permitted)。
 *
 * 段階 fallback (§12.2):
 *   - active 無し / dense も lexical も空 → **full permitted catalog**
 *   - dense stale (embed モデル/次元不一致) でも lexical が生きていれば **lexical-only**
 *   - それ以外 → **hybrid**
 *
 * query は trusted な user 発話を渡す (untrusted は混ぜない、§4.0)。
 * permitted = §4.0 の policy で露出可能な ToolDef 群。候補はこの範囲に限定。
 */
export async function retrieveToolCandidates(opts: {
  query: string;
  permitted: ToolDef[];
  k?: number;
}): Promise<ToolRetrieval> {
  const { query, permitted } = opts;
  const k = Math.max(1, Math.min(50, Math.floor(opts.k ?? DEFAULT_TOP_K)));
  const permittedNames = permitted.map((t) => t.name);
  const fullCatalog = (): ToolRetrieval => ({ toolNames: permittedNames, mode: "full-catalog" });

  if (permittedNames.length === 0) return { toolNames: [], mode: "full-catalog" };
  const active = await getActiveToolIndexVersion();
  if (!active) return fullCatalog();

  // active version の embed メタで dense の stale/次元不一致を検知 (lexical は embedding 非依存)
  const cfg = await getEmbedConfig();
  const meta = (await rawSql<{ embedding_model: string; embedding_dimensions: number }[]>`
    SELECT embedding_model, embedding_dimensions FROM tool_index
    WHERE index_version = ${active} LIMIT 1`)[0];
  const denseUsable =
    !!meta && meta.embedding_model === cfg.model && meta.embedding_dimensions === cfg.dimensions;

  // 1. dense ranked (tool ごと最良 cosine 距離で順位付け)。
  // embed / dense SQL 失敗時は retrieval 全体を落とさず lexical-only / full に倒す (Codex High)。
  let denseRanked: string[] = [];
  let denseActuallyUsable = denseUsable;
  if (denseUsable) {
    try {
      const qVec = toPgVector((await embed(query)) as number[]);
      const dr = await rawSql<{ tool_name: string }[]>`
        SELECT tool_name FROM tool_index
        WHERE index_version = ${active} AND tool_name = ANY(${permittedNames})
        GROUP BY tool_name
        ORDER BY min(embedding <=> ${qVec}::vector)
        LIMIT ${k}`;
      denseRanked = dr.map((r) => r.tool_name);
    } catch (e) {
      console.warn("[tool-index] dense retrieval 失敗 → lexical/full に fallback:", e);
      denseActuallyUsable = false;
    }
  }

  // 2. lexical ranked (PGroonga score。任意の user 発話を query 構文に渡すので失敗は空扱い)
  let lexicalRanked: string[] = [];
  try {
    const lr = await rawSql<{ tool_name: string }[]>`
      SELECT tool_name FROM (
        SELECT tool_name, pgroonga_score(tableoid, ctid) AS score
        FROM tool_index
        WHERE index_version = ${active} AND tool_name = ANY(${permittedNames}) AND text &@~ ${query}
      ) s GROUP BY tool_name ORDER BY max(score) DESC LIMIT ${k}`;
    lexicalRanked = lr.map((r) => r.tool_name);
  } catch (e) {
    // PGroonga query 構文エラー / 拡張欠落 / timeout 等 → lexical 無し扱い (障害は warn で可視化)
    console.warn("[tool-index] lexical (PGroonga) retrieval 失敗 → lexical 無しで継続:", e);
    lexicalRanked = [];
  }

  if (denseRanked.length === 0 && lexicalRanked.length === 0) return fullCatalog();

  // 3. RRF 融合
  const rrf = new Map<string, number>();
  const accumulate = (ranked: string[]) =>
    ranked.forEach((t, i) => rrf.set(t, (rrf.get(t) ?? 0) + 1 / (RRF_K + i + 1)));
  accumulate(denseRanked);
  accumulate(lexicalRanked);
  const ranked = [...rrf.entries()].sort((a, b) => b[1] - a[1]).map(([t]) => t).slice(0, k);

  // 4. 候補 = floor ∪ RRF-topK ∪ dependentReads (∩ permitted)
  const permittedSet = new Set(permittedNames);
  const byName = new Map(permitted.map((t) => [t.name, t]));
  const cand = new Set<string>();
  for (const t of FLOOR_TOOLS) if (permittedSet.has(t)) cand.add(t);
  for (const t of ranked) cand.add(t);

  // dependentReads: **既存エンティティを操作する mutate** (delete/update 等) 候補があれば
  // 同 domain の read ツールを同梱 (ID 解決 mini-loop 用、§12.2)。
  // 作成系 (add_/create_/set_/save_/write_) は事前 read 不要なので対象外
  // (= floor の作成系ツールが毎回 read を引き込む inflation を防ぐ)。
  const needsIdResolution = (def: ToolDef) =>
    def.surface === "mutate" && !/^(add|create|set|save|write)_/.test(def.name);
  const mutateDomains = new Set<string>();
  for (const t of cand) {
    const def = byName.get(t);
    if (def && needsIdResolution(def)) mutateDomains.add(def.domain);
  }
  if (mutateDomains.size > 0) {
    for (const t of permitted) {
      if (t.surface === "read" && mutateDomains.has(t.domain)) cand.add(t.name);
    }
  }

  return { toolNames: [...cand], mode: denseActuallyUsable ? "hybrid" : "lexical-only" };
}
