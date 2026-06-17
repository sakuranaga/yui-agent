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
import { db } from "@/db/client";
import { eq, ne, sql } from "drizzle-orm";
import { toolIndex, toolIndexMeta, type NewToolIndexRow } from "@/db/schema";
import { embed } from "@/lib/embed";
import { getEmbedConfig } from "@/lib/ai-settings";
import { ALL_TOOLS } from "@/lib/tools/registry";
import { TOOL_EXAMPLES } from "@/lib/tools/tool-examples";

export const ACTIVE_VERSION_KEY = "active_tool_index_version";

const EMBED_BATCH = 64; // embed() に一度に渡す件数 (短文なので 64 で十分)
const INSERT_CHUNK = 100;

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
