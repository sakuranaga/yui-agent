/**
 * Embedding client for the local bge-m3 service (llama.cpp + llama-embed.service).
 * Uses the OpenAI-compatible /v1/embeddings endpoint.
 *
 * 設定は AI 設定タブ (DB) → .env → ハードコードデフォルトの順で解決される。
 * docs/ai-settings.md 参照。
 */

import { getEmbedConfig } from "@/lib/ai-settings";

type EmbedResponse = {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage: { prompt_tokens: number; total_tokens: number };
};

/**
 * Embed a single text (or batch).
 * Returns the embedding vector(s).
 */
export async function embed(input: string): Promise<number[]>;
export async function embed(input: string[]): Promise<number[][]>;
export async function embed(
  input: string | string[]
): Promise<number[] | number[][]> {
  const isBatch = Array.isArray(input);
  const cfg = await getEmbedConfig();

  // bge-m3 サーバの batch size は 512 tokens。日本語の worst case (1.5 token/char)
  // でも収まるよう 1500 chars で hard cap + warn。caller 側で短くするのが正解だが、
  // ここでも防御線を張る (全 caller を漏れなく面倒みるため)。
  const SAFE_CHARS = 1500;
  const safen = (s: string) => {
    if (s.length <= SAFE_CHARS) return s;
    console.warn(`[embed] input ${s.length} chars exceeds ${SAFE_CHARS}, truncating`);
    return s.slice(0, SAFE_CHARS);
  };
  const safeInput = isBatch ? (input as string[]).map(safen) : safen(input as string);

  const payload = {
    model: cfg.model,
    input: isBatch ? safeInput : [safeInput as string],
  };

  // SSRF 防護: cfg.url は user 設定 (= AI 設定タブ) なので safeFetch 経由。
  // 内部 IP / Tailnet 等を許可するには env SAFE_FETCH_ALLOWED_HOSTS で明示登録。
  const { safeFetch } = await import("@/lib/safe-fetch");
  const res = await safeFetch(cfg.url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    timeoutMs: 30_000,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Embedding API failed: ${res.status} ${body}`);
  }

  const data = (await res.json()) as EmbedResponse;
  if (!data.data || data.data.length === 0) {
    throw new Error("Embedding API returned no data");
  }

  // 念のため次元チェック (設定の次元数と返り値が一致しないと、後の vector 列で死ぬ)
  const dim = data.data[0].embedding.length;
  if (dim !== cfg.dimensions) {
    throw new Error(
      `Embedding dimension mismatch: expected ${cfg.dimensions}, got ${dim}`
    );
  }

  const vectors = data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);

  return isBatch ? vectors : vectors[0];
}

/**
 * 同期 export を維持するためのレガシー値 (pgvector schema 定義など、
 * import 時点で固定値が必要な箇所で使う)。
 * 実行時の比較には getEmbedConfig().dimensions を直接使うこと。
 */
export const EMBED_DIMENSIONS = parseInt(
  process.env.EMBED_DIMENSIONS ?? "1024",
  10
);

/**
 * pgvector の入力形式 ('[0.1, 0.2, ...]' という文字列) に変換。
 * SQL に直接埋め込むときに使う。drizzle の customType でも同じ変換をしてるので
 * INSERT 時には不要、raw SQL query で必要なときだけ使う。
 */
export function toPgVector(v: number[]): string {
  return `[${v.join(",")}]`;
}
