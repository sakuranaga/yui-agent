/**
 * 共有 web tools: SearXNG 検索 + 任意 URL fetch。
 *
 * Yui の主ターン + 任意の specialist が同じ tool 定義を取り込んで使う。
 * Tool 実装は同じ、宣言の場所だけ違う。
 *
 * SearXNG は docker-compose の searxng service (内部 host `searxng:8080`)。
 *
 * Yui 主ターンでは chat/route.ts が独自に inline で扱う (tool-use loop で同期実行)。
 * Specialist では `webSpecialistTools` をそのまま tools 配列に concat すれば使える
 * (handler 経由で SpecialistRunner が自動実行)。
 */
import type { SpecialistTool } from "@/lib/specialists/types";

const SEARXNG_BASE = process.env.SEARXNG_URL ?? "http://searxng:8080";
const FETCH_TIMEOUT_MS = 15_000;
const FETCH_MAX_BYTES = 1_500_000; // 1.5MB. これ以上は truncate

export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  engine?: string;
};

/**
 * SearXNG で web 検索。
 * @param query 検索クエリ
 * @param limit 返す件数 (default 8)
 * @param categories 任意の category (general/news/it/files 等)
 */
export async function searchWeb(opts: {
  query: string;
  limit?: number;
  categories?: string;
  language?: string;
}): Promise<SearchHit[]> {
  const url = new URL(`${SEARXNG_BASE}/search`);
  url.searchParams.set("q", opts.query);
  url.searchParams.set("format", "json");
  if (opts.categories) url.searchParams.set("categories", opts.categories);
  if (opts.language) url.searchParams.set("language", opts.language);
  else url.searchParams.set("language", "ja");

  // eslint-disable-next-line no-restricted-syntax -- SearXNG は env (SEARXNG_BASE) で固定内部ホスト、user 入力 URL ではない
  const res = await fetch(url.toString(), {
    headers: {
      Accept: "application/json",
      "User-Agent": "Yui/0.1 (+searxng client)",
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`SearXNG search → ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as {
    results?: Array<{
      title?: string;
      url?: string;
      content?: string;
      engine?: string;
    }>;
  };
  const results = data.results ?? [];
  const limit = opts.limit ?? 8;
  return results.slice(0, limit).map((r) => ({
    title: (r.title ?? "").trim(),
    url: r.url ?? "",
    snippet: (r.content ?? "").trim(),
    engine: r.engine,
  }));
}

/**
 * 任意 URL の本文を取得し、HTML ならざっくり text に。
 * 重い JS-rendered ページには対応しない (それは agent-browser 案件)。
 * - 最大 FETCH_MAX_BYTES でカット
 * - タイムアウト FETCH_TIMEOUT_MS
 * - <script>/<style>/<nav> 等を除去、空白整形
 */
export async function fetchUrl(opts: {
  url: string;
  maxChars?: number;
}): Promise<{ url: string; title: string | null; text: string; truncated: boolean }> {
  const target = opts.url;
  if (!/^https?:\/\//.test(target)) {
    throw new Error(`Only http(s) URLs are allowed: ${target}`);
  }

  // SSRF 防護: ユーザ / LLM 入力の任意 URL なので safeFetch 経由 (= 内部 IP / loopback /
  // metadata range は拒否、リダイレクトを手動追跡して各 hop で再検証)
  const { safeFetch } = await import("@/lib/safe-fetch");
  const res = await safeFetch(target, {
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Yui/0.1",
      Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      "Accept-Language": "ja,en;q=0.7",
    },
    timeoutMs: FETCH_TIMEOUT_MS,
    maxBytes: FETCH_MAX_BYTES,
  });

  if (!res.ok) {
    throw new Error(`fetch ${target} → ${res.status}`);
  }

  const ct = res.headers.get("content-type") ?? "";
  const isHtml = /text\/html|application\/xhtml/i.test(ct);
  const isText = /text\//i.test(ct);

  const buf = await res.arrayBuffer();
  const truncated = buf.byteLength > FETCH_MAX_BYTES;
  const sliced = truncated ? buf.slice(0, FETCH_MAX_BYTES) : buf;
  const raw = new TextDecoder("utf-8", { fatal: false }).decode(sliced);

  if (!isHtml && !isText) {
    return {
      url: target,
      title: null,
      text: `(non-text content: ${ct})`,
      truncated,
    };
  }

  const { title, text } = isHtml ? extractFromHtml(raw) : { title: null, text: raw };
  const cap = opts.maxChars ?? 8000;
  const finalText = text.length > cap ? text.slice(0, cap) + " …(truncated)" : text;

  return { url: target, title, text: finalText, truncated: truncated || text.length > cap };
}

function extractFromHtml(html: string): { title: string | null; text: string } {
  // <title>
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].trim()).slice(0, 200) : null;

  let body = html
    // 全 script/style/nav/header/footer/aside/form を除去
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<nav[\s\S]*?<\/nav>/gi, "")
    .replace(/<header[\s\S]*?<\/header>/gi, "")
    .replace(/<footer[\s\S]*?<\/footer>/gi, "")
    .replace(/<aside[\s\S]*?<\/aside>/gi, "")
    .replace(/<form[\s\S]*?<\/form>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "")
    // <br>, </p>, </div> 等は改行に
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, "\n")
    // 全タグ削除
    .replace(/<[^>]+>/g, "")
    // entities decode
    .split("\n")
    .map((l) => decodeEntities(l.trim()))
    .filter((l) => l.length > 0)
    .join("\n");

  // 連続改行を 1 つに圧縮
  body = body.replace(/\n{2,}/g, "\n\n").trim();

  return { title, text: body };
}

/**
 * Specialist 側で使うための tool 定義 (handler 付き)。
 * specialist.tools 配列に `...webSpecialistTools` で concat するだけで使える。
 */
export const webSpecialistTools: SpecialistTool[] = [
  {
    name: "web_search",
    description:
      "インターネットを検索して、上位の結果 (title / url / snippet) を返す。" +
      "specialist が自分の領域外の情報 (例: 曲のタイアップ / 用語の最新仕様 / 製品の現状) " +
      "を確認する時に使う。query には日本語 / 英語どちらも可。",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "integer", default: 8 },
        categories: {
          type: "string",
          description:
            "任意: general / news / it / files / images / videos / music / science のカンマ区切り",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (input) => {
      const hits = await searchWeb({
        query: String(input.query ?? ""),
        limit: input.limit as number | undefined,
        categories: input.categories as string | undefined,
      });
      return { count: hits.length, hits };
    },
  },
  {
    name: "web_fetch",
    description:
      "指定 URL の本文を取得して text として返す。web_search の結果 url か、" +
      "ユーザが提示した URL のみに使う。URL を推測して fetch しない。",
    input_schema: {
      type: "object",
      properties: {
        url: { type: "string", description: "http(s) URL" },
        max_chars: { type: "integer", default: 8000 },
      },
      required: ["url"],
      additionalProperties: false,
    },
    handler: async (input) => {
      return await fetchUrl({
        url: String(input.url ?? ""),
        maxChars: input.max_chars as number | undefined,
      });
    },
  },
];

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(parseInt(d, 10)));
}
