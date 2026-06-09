/**
 * ニュース一覧。RSS は periodic で 1 時間毎に DB に蓄積されている。
 * 結果に第三者のタイトル/概要 (= 外部由来文字列) が含まれるため untrustedOutput: true。
 */
import { listArticles as listNewsArticles, listSources as listNewsSources } from "@/lib/news";
import type { ToolDef } from "../types";

export const listNews: ToolDef = {
  name: "list_news",
  description:
    "DB にキャッシュされたニュース記事の一覧を取得 (新着順、pinned は先頭固定)。" +
    "ご主人様の「ニュース教えて」「今日のニュース」等の問いで使う。" +
    "source 絞り込み (例: 'NHK') や pinned_only で「保存したニュース」も取れる。" +
    "1 件 = タイトル + 概要 + ソース名 + 公開日時。RSS は 1 時間毎に自動取得されてる。",
  input_schema: {
    type: "object",
    properties: {
      source: {
        type: "string",
        description: "(任意) ソース名で絞り込み (例: 'NHK', '朝日', 'Hacker News')。partial match",
      },
      pinned_only: { type: "boolean", description: "(任意) true なら保存済みのみ" },
      limit: { type: "integer", description: "(任意) 件数上限。既定 20" },
      query: { type: "string", description: "(任意) title/summary キーワード検索" },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "news",
  untrustedOutput: true,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as {
      source?: unknown;
      pinned_only?: unknown;
      limit?: unknown;
      query?: unknown;
    };
    const source = typeof i.source === "string" ? i.source : undefined;
    const pinnedOnly = typeof i.pinned_only === "boolean" ? i.pinned_only : undefined;
    const limit = typeof i.limit === "number" ? i.limit : 20;
    const query = typeof i.query === "string" ? i.query : undefined;

    // source 名で指定された場合、id に解決
    let sourceId: number | undefined;
    if (source && source.length > 0) {
      const sources = await listNewsSources();
      const found = sources.find((s) =>
        s.name.toLowerCase().includes(source.toLowerCase())
      );
      if (!found) {
        throw new Error(`source '${source}' not found`);
      }
      sourceId = found.id;
    }
    const items = await listNewsArticles({
      sourceId,
      pinnedOnly,
      limit,
      query,
    });
    return {
      count: items.length,
      articles: items.map((a) => ({
        id: a.id,
        source: a.sourceName,
        title: a.title,
        summary: a.summary?.slice(0, 240),
        link: a.link,
        published_at: a.publishedAt.toISOString(),
        pinned: a.pinned,
      })),
    };
  },
};
