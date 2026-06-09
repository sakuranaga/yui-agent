/**
 * 栄養 lookup: 食材名 → 1 単位あたり kcal/PFC を返す。
 *
 * 設計: docs/food-tracking.md §7
 *
 * 順序:
 *   1. food_reference テーブル (normalized_name) を SELECT
 *      hit → 即返
 *   2. miss → SearxNG で「<name> カロリー 栄養」検索 (上位 5 件 snippet)
 *   3. Gemma に snippet を渡して JSON 抽出 (kcal/PFC/unit/confidence)
 *   4. food_reference に保存 → 返す
 *
 * 失敗時 (検索失敗 / LLM 失敗 / 抽出失敗) は null を返して caller で「kcal 不明」扱い。
 *
 * 精度: LLM+web で ±20-30%。料理 (定食) は更に幅広い。Yui 側で「概算」を必ず添える。
 */
import type Anthropic from "@anthropic-ai/sdk";
import { db } from "@/db/client";
import { foodReference } from "@/db/schema";
import { eq } from "drizzle-orm";
import { callLlm } from "@/lib/llm";
import { searchWeb } from "@/lib/tools/web";

export type Nutrition = {
  unit: string;             // "個" / "本" / "100g" / "杯" 等
  kcalPerUnit: number;
  protein: number | null;
  carbs: number | null;
  fat: number | null;
  fiber: number | null;
  // 食塩相当量 (g) per unit。日本の栄養成分表示で必須項目。
  salt: number | null;
  confidence: "high" | "medium" | "low";
  sourceUrl: string | null;
};

/** 食材名を引き当てる。null = lookup 失敗 (kcal 不明扱い) */
export async function lookupNutrition(name: string): Promise<Nutrition | null> {
  const norm = normalize(name);
  if (norm.length === 0) return null;

  // 1. cache hit?
  const [hit] = await db
    .select()
    .from(foodReference)
    .where(eq(foodReference.normalizedName, norm))
    .limit(1);
  if (hit) {
    return {
      unit: hit.unit,
      kcalPerUnit: hit.kcalPerUnit,
      protein: hit.protein,
      carbs: hit.carbs,
      fat: hit.fat,
      fiber: hit.fiber,
      salt: hit.salt,
      confidence: hit.confidence,
      sourceUrl: hit.sourceUrl,
    };
  }

  // 2. web で snippet 取得
  let snippets: string[] = [];
  let firstUrl: string | null = null;
  try {
    const results = await searchWeb({
      // 日本の栄養成分表示の標準項目をクエリに含めて、塩分も拾える snippet を取りに行く
      query: `${name} カロリー 栄養成分 食塩相当量`,
      limit: 5,
      language: "ja",
    });
    snippets = results
      .map((r) => `[${r.title}]\n${r.snippet}\nsrc: ${r.url}`)
      .filter((s) => s.length > 0);
    firstUrl = results[0]?.url ?? null;
  } catch (e) {
    console.warn(`[food-nutrition] search failed for ${name}:`, e instanceof Error ? e.message : e);
    return null;
  }
  if (snippets.length === 0) return null;

  // 3. LLM で抽出
  const parsed = await llmExtract(name, snippets);
  if (!parsed) return null;

  // 4. cache 保存
  try {
    await db
      .insert(foodReference)
      .values({
        normalizedName: norm,
        unit: parsed.unit,
        kcalPerUnit: parsed.kcalPerUnit,
        protein: parsed.protein,
        carbs: parsed.carbs,
        fat: parsed.fat,
        fiber: parsed.fiber,
        salt: parsed.salt,
        sourceUrl: firstUrl,
        confidence: parsed.confidence,
      })
      .onConflictDoNothing();
  } catch (e) {
    // cache 書き込み失敗は無視 (今回の lookup 結果は返す)
    console.warn(`[food-nutrition] cache write failed for ${norm}:`, e);
  }

  return parsed;
}

/** name を normalize key にする (大文字小文字 / 空白 / 記号を丸める) */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[!-/:-@\[-`{-~]/g, "") // ASCII 記号削除
    .trim();
}

const LLM_SYSTEM = `あなたは栄養データ抽出係です。検索結果 snippet から食材 1 単位あたりの栄養値を抽出します。

判定基準:
- 単位は元の食材表記に合った自然な単位 ("個" "本" "杯" "枚" "100g" "1人前" 等)
- 値の幅がある場合は中央値を採用
- snippet から確定できる場合は confidence=high、推定混じり=medium、ほぼ不明=low
- 不明な栄養素は null
- 日本の栄養成分表示の標準 5 項目 (kcal / 蛋白質 / 脂質 / 炭水化物 / 食塩相当量) は積極的に拾う。
  salt (食塩相当量) は g 単位。snippet に「ナトリウム XXmg」しか無い場合は salt = ナトリウム mg × 2.54 / 1000 で g に換算。

出力 JSON 1 行のみ、装飾不要:
{
  "unit": string,
  "kcalPerUnit": number,
  "protein": number | null,
  "carbs": number | null,
  "fat": number | null,
  "fiber": number | null,
  "salt": number | null,
  "confidence": "high" | "medium" | "low"
}`;

async function llmExtract(name: string, snippets: string[]): Promise<Nutrition | null> {
  const userMsg = [
    `食材名: ${name}`,
    "",
    "## 検索結果 snippet",
    snippets.slice(0, 5).join("\n\n---\n\n"),
    "",
    "上記から 1 単位あたりの栄養を JSON で返してください。",
  ].join("\n");

  let text = "";
  try {
    const res = await callLlm("food_extract", {
      system: LLM_SYSTEM,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: 300,
    });
    text = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
  } catch (e) {
    console.warn(`[food-nutrition] LLM extract failed for ${name}:`, e instanceof Error ? e.message : e);
    return null;
  }

  const cleaned = text
    .replace(/^```(?:json)?\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(m[0]);
  } catch {
    return null;
  }
  const unit = typeof parsed.unit === "string" ? parsed.unit : "個";
  const kcalPerUnit = num(parsed.kcalPerUnit);
  if (kcalPerUnit === null || kcalPerUnit < 0) return null;
  const confRaw = typeof parsed.confidence === "string" ? parsed.confidence : "low";
  const confidence: "high" | "medium" | "low" =
    confRaw === "high" ? "high" : confRaw === "medium" ? "medium" : "low";
  return {
    unit,
    kcalPerUnit,
    protein: num(parsed.protein),
    carbs: num(parsed.carbs),
    fat: num(parsed.fat),
    fiber: num(parsed.fiber),
    salt: num(parsed.salt),
    confidence,
    sourceUrl: null,
  };
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = parseFloat(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}
