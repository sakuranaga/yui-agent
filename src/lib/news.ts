/**
 * ニュース取得 + cache。
 *
 * - 1 時間毎 periodic で全 enabled source の RSS を fetch
 * - 重複は (source_id, guid) で防止 (ON CONFLICT DO NOTHING)
 * - 3 日 TTL で auto delete (pinned=true は永続)
 * - LLM は使わない — 純粋取得・蓄積
 */
import Parser from "rss-parser";
import { and, asc, desc, eq, ilike, lt, or, type SQL } from "drizzle-orm";
import { db } from "@/db/client";
import {
  newsArticles,
  newsSources,
  type NewsArticle,
  type NewsSource,
} from "@/db/schema";

const parser = new Parser({
  timeout: 8000,
  headers: { "User-Agent": "yui-news/0.1 (+https://github.com/local)" },
});

// ---------- Sources ----------

export async function listSources(opts: { enabledOnly?: boolean } = {}): Promise<NewsSource[]> {
  const conds: SQL[] = [];
  if (opts.enabledOnly) conds.push(eq(newsSources.enabled, true));
  return db
    .select()
    .from(newsSources)
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(asc(newsSources.id));
}

export async function addSource(opts: { name: string; url: string }): Promise<NewsSource> {
  const [row] = await db
    .insert(newsSources)
    .values({ name: opts.name, url: opts.url, enabled: true })
    .onConflictDoNothing({ target: newsSources.url })
    .returning();
  if (row) return row;
  // 既存 url の場合は select で返す
  const [existing] = await db
    .select()
    .from(newsSources)
    .where(eq(newsSources.url, opts.url))
    .limit(1);
  return existing;
}

export async function removeSource(id: number): Promise<void> {
  await db.delete(newsSources).where(eq(newsSources.id, id));
}

export async function setSourceEnabled(id: number, enabled: boolean): Promise<NewsSource | null> {
  const [row] = await db
    .update(newsSources)
    .set({ enabled })
    .where(eq(newsSources.id, id))
    .returning();
  return row ?? null;
}

/** name / url の部分更新。enabled は setSourceEnabled を使う。 */
export async function updateSource(
  id: number,
  patch: { name?: string; url?: string }
): Promise<NewsSource | null> {
  const set: { name?: string; url?: string } = {};
  if (patch.name !== undefined) set.name = patch.name;
  if (patch.url !== undefined) set.url = patch.url;
  if (Object.keys(set).length === 0) {
    const [row] = await db.select().from(newsSources).where(eq(newsSources.id, id)).limit(1);
    return row ?? null;
  }
  const [row] = await db
    .update(newsSources)
    .set(set)
    .where(eq(newsSources.id, id))
    .returning();
  return row ?? null;
}

// ---------- Articles ----------

export type ListArticlesOpts = {
  sourceId?: number;
  pinnedOnly?: boolean;
  limit?: number;
  /** これより古い id を返す (ページネーション用) */
  beforeId?: number;
  query?: string;
};

export async function listArticles(opts: ListArticlesOpts = {}): Promise<
  Array<NewsArticle & { sourceName: string }>
> {
  const limit = opts.limit ?? 50;
  const conds: SQL[] = [];
  if (opts.sourceId !== undefined) conds.push(eq(newsArticles.sourceId, opts.sourceId));
  if (opts.pinnedOnly) conds.push(eq(newsArticles.pinned, true));
  if (opts.beforeId !== undefined) conds.push(lt(newsArticles.id, opts.beforeId));
  if (opts.query && opts.query.length > 0) {
    const q = `%${opts.query}%`;
    conds.push(or(ilike(newsArticles.title, q), ilike(newsArticles.summary, q))!);
  }
  const rows = await db
    .select({
      id: newsArticles.id,
      sourceId: newsArticles.sourceId,
      guid: newsArticles.guid,
      title: newsArticles.title,
      link: newsArticles.link,
      summary: newsArticles.summary,
      publishedAt: newsArticles.publishedAt,
      fetchedAt: newsArticles.fetchedAt,
      pinned: newsArticles.pinned,
      pinnedAt: newsArticles.pinnedAt,
      score: newsArticles.score,
      scoreReason: newsArticles.scoreReason,
      curatedAt: newsArticles.curatedAt,
      sourceName: newsSources.name,
    })
    .from(newsArticles)
    .innerJoin(newsSources, eq(newsArticles.sourceId, newsSources.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    // 一覧: pinned を先頭、その後は新着順
    .orderBy(
      desc(newsArticles.pinned),
      desc(newsArticles.publishedAt),
      desc(newsArticles.id)
    )
    .limit(limit);
  return rows;
}

export async function pinArticle(id: number, pinned: boolean): Promise<NewsArticle | null> {
  const [row] = await db
    .update(newsArticles)
    .set({ pinned, pinnedAt: pinned ? new Date() : null })
    .where(eq(newsArticles.id, id))
    .returning();
  return row ?? null;
}

// ---------- Fetch (RSS → DB) ----------

export type FetchResult = {
  source: NewsSource;
  fetched: number;
  inserted: number;
  /** 新規挿入された article ID 群 (curate に渡す) */
  insertedIds: number[];
  error?: string;
};

/**
 * 1 source の RSS を fetch して新着を upsert する。
 * 既存記事 (source_id + guid 重複) は ON CONFLICT DO NOTHING で無視。
 */
export async function fetchOneSource(source: NewsSource): Promise<FetchResult> {
  try {
    // SSRF 防護: 登録時に validatePublicUrl したが、登録後 DNS 変更 / redirect 先が
    // 内部 IP になるケースを fetch 時にも捕まえる。safeFetch が hop ごとに再検証する。
    const { safeFetch } = await import("@/lib/safe-fetch");
    const res = await safeFetch(source.url, {
      headers: { Accept: "application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.8" },
      timeoutMs: 30_000,
      maxBytes: 10 * 1024 * 1024, // 10MB (= 大きい RSS でも収まる)
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const xml = await res.text();
    const feed = await parser.parseString(xml);
    const items = feed.items ?? [];
    const rows = items
      .map((it) => {
        const guid = it.guid ?? it.id ?? it.link;
        const title = it.title ?? "";
        if (!guid || !title) return null;
        const summary = it.contentSnippet ?? it.summary ?? null;
        const link = it.link ?? null;
        const isoDate = it.isoDate ?? it.pubDate ?? null;
        const published = isoDate ? new Date(isoDate) : new Date();
        if (Number.isNaN(published.getTime())) return null;
        return {
          sourceId: source.id,
          guid,
          title,
          link,
          summary,
          publishedAt: published,
        };
      })
      .filter((r): r is NonNullable<typeof r> => r !== null);

    if (rows.length === 0) return { source, fetched: 0, inserted: 0, insertedIds: [] };

    const inserted = await db
      .insert(newsArticles)
      .values(rows)
      .onConflictDoNothing({
        target: [newsArticles.sourceId, newsArticles.guid],
      })
      .returning({ id: newsArticles.id });

    return {
      source,
      fetched: rows.length,
      inserted: inserted.length,
      insertedIds: inserted.map((r) => r.id),
    };
  } catch (e) {
    return {
      source,
      fetched: 0,
      inserted: 0,
      insertedIds: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/** 全 enabled source を並列 fetch。失敗 1 件で全体を止めない。 */
export async function fetchAllSources(): Promise<FetchResult[]> {
  const sources = await listSources({ enabledOnly: true });
  return Promise.all(sources.map((s) => fetchOneSource(s)));
}

// ---------- TTL Cleanup ----------

const TTL_MS = 3 * 24 * 60 * 60 * 1000; // 3 日

/**
 * published_at が 3 日より古く、かつ pinned=false の row を削除。
 * pinned=true (ユーザが保存指示したもの) は永続。
 */
export async function pruneOldNews(): Promise<{ deleted: number }> {
  const cutoff = new Date(Date.now() - TTL_MS);
  const deleted = await db
    .delete(newsArticles)
    .where(
      and(
        eq(newsArticles.pinned, false),
        lt(newsArticles.publishedAt, cutoff)
      )
    )
    .returning({ id: newsArticles.id });
  return { deleted: deleted.length };
}

