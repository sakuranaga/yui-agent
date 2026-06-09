/**
 * ニュース見出しに興味スコアを付与する (Haiku batch)。
 *
 * 入力: ユーザーの興味プロファイル (自由テキスト) + 新着 article ID 配列
 * 出力: 各 article に score / score_reason / curated_at を DB 保存
 *
 * - 記憶は使わない (テスト容易・即時制御)
 * - 失敗時 silent (score=null のまま、お便りなし方向に倒す)
 *
 * 設計: docs/news-curation.md §3
 */
import Anthropic from "@anthropic-ai/sdk";
import { inArray, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { newsArticles, newsSources } from "@/db/schema";
import { callLlm } from "@/lib/llm";
import { getCurationSettings } from "@/lib/news-curation-settings";

type CurationVerdict = {
  idx: number; // 1-based
  score: number; // 0.0-1.0
  reason: string;
};

const SYSTEM_PROMPT = `あなたはニュースキュレーターです。
ユーザーの興味プロファイルに沿って、各ニュース見出しに 0.0〜1.0 のスコアを付けてください。

判定基準:
- 0.8〜1.0: 強く関心ありそう (プロファイルに直接一致)
- 0.5〜0.8: 関連ありそう (隣接ドメイン)
- 0.2〜0.5: 関心薄
- 0.0〜0.2: 不要 / 興味なしと明示 / ネガティブな話題

プロファイルが空の場合は、一般的なニュース価値で 0.4〜0.6 のあたりに揃えてください。

出力は JSON 配列のみ。各見出しの 1-based idx を必ず含めてください。
[{"idx": 1, "score": 0.95, "reason": "新モデルリリース"},
 {"idx": 2, "score": 0.05, "reason": "事故"}, ...]

説明文・装飾・コードブロック不要。`;

/**
 * 指定 article 群に対して curate を実行し、score を DB に保存する。
 * 失敗しても throw しない (warn のみ)。
 */
export async function curateArticles(articleIds: number[]): Promise<void> {
  if (articleIds.length === 0) return;

  const settings = await getCurationSettings();

  // タイトル + ソース名を取得
  const articles = await db
    .select({
      id: newsArticles.id,
      title: newsArticles.title,
      sourceName: newsSources.name,
    })
    .from(newsArticles)
    .innerJoin(newsSources, eq(newsArticles.sourceId, newsSources.id))
    .where(inArray(newsArticles.id, articleIds));

  if (articles.length === 0) return;

  // 50 件超は 2 分割 (JSON 出力安定性のため)
  const BATCH_SIZE = 50;
  for (let i = 0; i < articles.length; i += BATCH_SIZE) {
    const batch = articles.slice(i, i + BATCH_SIZE);
    await curateBatch(batch, settings.interestProfile);
  }
}

async function curateBatch(
  batch: Array<{ id: number; title: string; sourceName: string }>,
  interestProfile: string
): Promise<void> {
  const userMsg = [
    `## ユーザーの興味プロファイル`,
    interestProfile.trim() || "(未設定 — 一般的なニュース価値で判定してください)",
    ``,
    `## ニュース一覧`,
    ...batch.map((a, i) => `${i + 1}. ${a.title} — ${a.sourceName}`),
    ``,
    `各見出しの idx は上記の番号 (1-based) を使用してください。`,
  ].join("\n");

  let response;
  try {
    response = await callLlm("news_curate", {
      maxTokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });
  } catch (e) {
    console.warn(`[news-curate] LLM call failed (batch=${batch.length}):`, e);
    return;
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let verdicts: CurationVerdict[];
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*\n/, "")
      .replace(/\n```\s*$/, "")
      .trim();
    verdicts = JSON.parse(cleaned);
    if (!Array.isArray(verdicts)) throw new Error("not an array");
  } catch (e) {
    console.warn(
      `[news-curate] JSON parse failed: ${e}\n---raw---\n${text.slice(0, 300)}`
    );
    return;
  }

  // verdict → DB 保存
  const now = new Date();
  await Promise.allSettled(
    verdicts.map(async (v) => {
      const idx = v.idx - 1;
      if (idx < 0 || idx >= batch.length) {
        console.warn(`[news-curate] invalid idx: ${v.idx} (batch size ${batch.length})`);
        return;
      }
      const score = clamp01(v.score);
      const reason = typeof v.reason === "string" ? v.reason.slice(0, 200) : "";
      await db
        .update(newsArticles)
        .set({ score, scoreReason: reason, curatedAt: now })
        .where(eq(newsArticles.id, batch[idx].id));
    })
  );

  console.log(
    `[news-curate] scored ${verdicts.length}/${batch.length} (max=${Math.max(
      ...verdicts.map((v) => v.score)
    ).toFixed(2)})`
  );
}

function clamp01(n: unknown): number {
  const x = typeof n === "number" ? n : parseFloat(String(n));
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
