/**
 * 会話から食事ログを「即時 post-turn」で抽出して food_logs に保存する。
 *
 * v2 (2026-06-05〜) 設計変更点:
 *   - 旧: 5 分 debounce → 全文 50 件一括抽出 → 文字列完全一致 dedup
 *         (= 同じ食事を別言い回しで複数回言うと重複登録の事故)
 *   - 新: chat/route から fire-and-forget で即時 trigger
 *         → 直近 user/assistant のみ + 直近 10 食 (24h) を context として LLM に渡し
 *         → LLM が「既登録の食事」を自分で除外
 *         → kcal/PFC の値があれば user 申告として nutrition_status=manual_user で保存
 *         → 無ければ nutrition_status=pending で保存し、Haiku worker が後追いで lookup
 *   - primary は callLlm("food_extract") = AI 設定で local LLM (Gemma 等) が有効なら
 *     ローカル経路、それ以外なら haikuModel。failure 時はユーザ指定 sub model (haikuModel) で
 *     1 度だけフォールバック。
 *
 * メトリクス (体重 / 体脂肪 / 気分) は従来通り同じ Gemma 出力から拾って保存。
 *
 * private モード会話は raw_messages に書かれないので chat/route 側で trigger しないだけで自動除外。
 */
import { db } from "@/db/client";
import { rawMessages, foodLogs, bodyMetrics } from "@/db/schema";
import { and, eq, desc, gte } from "drizzle-orm";
import { callLlm } from "@/lib/llm";
import { getAnthropicConfig } from "@/lib/ai-settings";
import type Anthropic from "@anthropic-ai/sdk";

const CONFIDENCE_THRESHOLD = 0.7;
const RECENT_FOODS_WINDOW_HOURS = 24;
const RECENT_FOODS_LIMIT = 10;

// 食事 or メトリクス言及がない発話は LLM 呼ばない (= cost 削減)
const FOOD_SIGNAL_RE =
  /食べ|たべ|食事|朝ご?飯|朝食|昼ご?飯|昼飯|ランチ|お昼|夕飯|晩ご?飯|夜ご?飯|夜食|おやつ|間食|飲ん|飲み|カロリー|kcal|栄養|体重|体脂肪|キロ|疲れ|だるい|元気|絶好調|しんどい|気分/u;

const SYSTEM_PROMPT = `あなたはご主人様の会話から、(1) 食事ログ と (2) 体組成・気分などのメトリクス を同時に抽出する係です。

# 食事 (foods)
- 過去〜現在進行の食事 → 配列に追加
- 「これから食べる」「明日の朝ごはん何にしよう」等の予定 → 除外
- 「美味しそう」「見た」等の話題化のみで自分が食べていない → 除外
- 「サンドイッチ買ってきた」だけで「食べた」が無い → 除外
- 1 つの食事 = 同じ時刻に同じ場面で食べたもの。朝/昼/夜/おやつ や明示時刻が違えば**別行**
- 例「朝はサンドイッチ、昼はカレー」→ foods が 2 行

# 🚨 重複登録の禁止 (最重要)
"## 既に登録済みの食事" セクションに同じ食事 (同じ料理名 + 概ね同じ時刻) があれば
**foods から完全に除外**してください。同じ「お蕎麦」を 2 度言っても 1 ログのままにする。
逆に「そば → プリン → そば」みたいに本当に別タイミングで 2 度食べた場合は 2 ログにする。
判断材料: eaten_at が 1 時間以上離れていれば別の食事、近ければ同じ食事。

# user 申告の栄養 (任意フィールド)
ご主人様が会話で kcal や PFC、食塩相当量を明示していたら値を拾って下記フィールドに入れる。
("カレー 800kcal だったらしい" "P:30 C:60 F:20 のサラダ" "塩分 2.3g" 等)
- user_kcal     (number, optional)
- user_protein  (g, optional)
- user_carbs    (g, optional)
- user_fat      (g, optional)
- user_fiber    (g, optional)
- user_salt     (g, 食塩相当量, optional)
推測 / 検索結果は入れない (= LLM が知ってる値も入れない)。これらが無ければ後で別 worker が web 検索で fill する。
※ パッケージの「栄養成分表示」を user が読み上げた場合は 5 項目 (kcal + PFC + salt) 全部拾ってよい。

# notes (任意 string)
発話から食事以外の付帯情報を拾って 1-2 文で要約。誰と / どこで / 印象 / シーン等。
例: "妹さんとイタリアン", "ジム帰りに立ち寄ったカフェ", "ご主人様の機嫌が良かった夕食"
情報が無ければ省略。

# メトリクス (metrics)
ご主人様の体について話している数値 / 状態を拾う。話題に出てこないなら空配列。
- weight_kg : 体重 (例「今朝 72.3kg」「体重 73 キロ」)
- body_fat_pct : 体脂肪率 (例「体脂肪 18%」)
- mood_1to5 : 気分 (5=絶好調 4=元気 3=普通 2=疲れた 1=しんどい) — 「疲れた」「絶好調」等を 1-5 にマッピング
他人や物の話は除外。

# 出力 JSON 1 行のみ、装飾やコードフェンス不要

{
  "foods": [
    {
      "items": [{"name": string, "quantity": number?, "unit": string?}],
      "eaten_at_iso": string,
      "raw_text_excerpt": string,
      "confidence": 0.0〜1.0,
      "notes": string?,
      "user_kcal": number?,
      "user_protein": number?,
      "user_carbs": number?,
      "user_fat": number?,
      "user_fiber": number?,
      "user_salt": number?
    }
  ],
  "metrics": [
    {
      "metric_type": "weight_kg" | "body_fat_pct" | "mood_1to5",
      "value": number,
      "recorded_at_iso": string,
      "confidence": 0.0〜1.0
    }
  ]
}

## eaten_at_iso / recorded_at_iso の決め方 (優先順位高 → 低)
1. 文中に明示時刻 ("9時に" "12:30に" "今朝") → そのまま採用
2. "今 / さっき / たった今" → 会話時刻
3. meal カテゴリ単独 ("朝ごはん" "ランチ" 等):
     朝ごはん/朝食   = その日の 08:00
     ランチ/お昼     = その日の 12:30
     夕飯/晩御飯/夜ご飯 = その日の 19:30
     夜食/夜中食べた = その日の 22:30
     おやつ          = その日の 15:00
4. "昨日の◯◯" 等の日付ヒント → 該当日の上記標準時刻 or 明示時刻
5. それ以外 → 会話時刻
※ 体重は通常「今朝」「夜」など → 朝なら 07:00、夜なら 22:00、不明なら会話時刻`;

type FoodPart = {
  items: Array<{ name: string; quantity?: number; unit?: string }>;
  eaten_at_iso: string;
  raw_text_excerpt: string;
  confidence: number;
  notes?: string;
  user_kcal?: number;
  user_protein?: number;
  user_carbs?: number;
  user_fat?: number;
  user_fiber?: number;
  user_salt?: number;
};

type MetricPart = {
  metric_type: "weight_kg" | "body_fat_pct" | "mood_1to5";
  value: number;
  recorded_at_iso: string;
  confidence: number;
};

type ExtractResult = {
  foods: FoodPart[];
  metrics: MetricPart[];
};

/**
 * 直近 user 発話に明示的なメトリクス記述 (体重 70kg / 体脂肪 20% / 気分 4) があれば
 * その場で regex 抽出して body_metrics に即時保存する。
 * Yui の応答前に呼ばれるので、同ターンの get_food_summary が新値を読める。
 * 食事みたいに lookup が要らないので、軽くて同期で OK。
 */
export async function quickSaveExplicitMetrics(
  userText: string,
  sourceMessageId: number | null
): Promise<number> {
  if (!userText) return 0;
  const now = new Date();
  const since6h = new Date(now.getTime() - 6 * 60 * 60 * 1000);
  let saved = 0;

  type Hit = { metric_type: string; value: number; min: number; max: number };
  const hits: Hit[] = [];

  const weightRe = /(?:体重\s*(?:は|が|:)?\s*)?(\d{2,3}(?:\.\d{1,2})?)\s*(?:kg|Kg|KG|キロ|㎏)/gu;
  for (const m of userText.matchAll(weightRe)) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) hits.push({ metric_type: "weight_kg", value: v, min: 20, max: 300 });
  }

  const bfRe = /体脂肪(?:率)?\s*(?:は|が|:)?\s*(\d{1,2}(?:\.\d{1,2})?)\s*%/gu;
  for (const m of userText.matchAll(bfRe)) {
    const v = parseFloat(m[1]);
    if (Number.isFinite(v)) hits.push({ metric_type: "body_fat_pct", value: v, min: 3, max: 60 });
  }

  const moodRe = /気分\s*(?:は|が|:)?\s*([1-5])(?:\s*\/\s*5)?\b/gu;
  for (const m of userText.matchAll(moodRe)) {
    const v = parseInt(m[1], 10);
    if (Number.isFinite(v)) hits.push({ metric_type: "mood_1to5", value: v, min: 1, max: 5 });
  }

  for (const h of hits) {
    if (h.value < h.min || h.value > h.max) continue;
    const dups = await db
      .select({ id: bodyMetrics.id })
      .from(bodyMetrics)
      .where(
        and(
          eq(bodyMetrics.metricType, h.metric_type),
          eq(bodyMetrics.value, h.value),
          gte(bodyMetrics.recordedAt, since6h)
        )
      )
      .limit(1);
    if (dups.length > 0) {
      console.log(`[quick-metric] dedup skip: ${h.metric_type}=${h.value}`);
      continue;
    }
    await db.insert(bodyMetrics).values({
      metricType: h.metric_type,
      value: h.value,
      recordedAt: now,
      source: "extracted",
      sourceMessageId,
    });
    console.log(`[quick-metric] saved: ${h.metric_type}=${h.value}`);
    saved++;
  }
  return saved;
}

/**
 * chat/route から fire-and-forget で呼ばれる即時抽出 entry point。
 * 旧 scheduleExtract と互換シグネチャ (= 引数 sessionId のみ) で、内部で
 * 直近 turn + 直近 food_logs を取得して LLM に投げる。
 */
export async function scheduleExtract(sessionId: string): Promise<void> {
  await extractFoodFromSession(sessionId);
}

/** デバッグ / 手動 trigger 用 (= scheduleExtract と同等の即時実行) */
export async function runExtractNow(sessionId: string): Promise<void> {
  await extractFoodFromSession(sessionId);
}

async function extractFoodFromSession(sessionId: string): Promise<void> {
  // 直近 4 件 (= 1-2 turn pair) のみ取得。前ターン以前の発話は extract 済として扱う。
  const recent = await db
    .select({
      id: rawMessages.id,
      role: rawMessages.role,
      content: rawMessages.content,
      createdAt: rawMessages.createdAt,
      source: rawMessages.source,
    })
    .from(rawMessages)
    .where(eq(rawMessages.sessionId, sessionId))
    .orderBy(desc(rawMessages.createdAt), desc(rawMessages.id))
    .limit(4);
  if (recent.length === 0) return;

  const window = recent
    .filter((r) => !(r.role === "user" && r.source === "cron"))
    .reverse();
  if (window.length === 0) return;

  const userText = window
    .filter((r) => r.role === "user")
    .map((r) => r.content)
    .join("\n");
  if (!FOOD_SIGNAL_RE.test(userText)) return;

  // 直近 24h の food_logs (= LLM に「既登録」として渡して重複登録を抑制)
  const sinceDay = new Date(Date.now() - RECENT_FOODS_WINDOW_HOURS * 60 * 60 * 1000);
  const recentFoods = await db
    .select({
      id: foodLogs.id,
      eatenAt: foodLogs.eatenAt,
      items: foodLogs.items,
    })
    .from(foodLogs)
    .where(gte(foodLogs.eatenAt, sinceDay))
    .orderBy(desc(foodLogs.eatenAt))
    .limit(RECENT_FOODS_LIMIT);

  const recentSummary =
    recentFoods.length > 0
      ? recentFoods
          .map((f) => {
            const itemList = Array.isArray(f.items)
              ? (f.items as Array<{ name?: string; quantity?: number; unit?: string }>)
                  .map((i) => i.name ?? "?")
                  .join(", ")
              : "?";
            return `- ${formatJst(f.eatenAt)} : ${itemList}`;
          })
          .join("\n")
      : "(まだ何も登録されていません)";

  const context = window
    .map((r) => `[${r.role} @ ${formatJst(r.createdAt)}] ${r.content}`)
    .join("\n");

  const userMsg = [
    "## 現在時刻 (JST)",
    jstNow(),
    "",
    `## 既に登録済みの食事 (直近 ${RECENT_FOODS_WINDOW_HOURS}h, 最大 ${RECENT_FOODS_LIMIT} 件)`,
    recentSummary,
    "",
    "## 今回の会話 (古→新)",
    context,
    "",
    "上記から、新規の食事ログとメトリクスを抽出して JSON 1 行で返してください。既登録と同じ食事は除外。",
  ].join("\n");

  let parsed: ExtractResult | null = null;
  try {
    const response = await callExtractWithFallback(userMsg);
    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    parsed = parseJsonLoose(text);
  } catch (e) {
    console.warn(
      "[food-extract] primary + fallback both failed:",
      e instanceof Error ? e.message : e
    );
    return;
  }
  if (!parsed) {
    console.warn("[food-extract] LLM returned no parseable JSON");
    return;
  }

  // メトリクス保存 (食事と独立に処理)
  await saveMetrics(Array.isArray(parsed.metrics) ? parsed.metrics : [], window);

  const foods: FoodPart[] = Array.isArray(parsed.foods) ? parsed.foods : [];
  if (foods.length === 0) {
    console.log("[food-extract] no new foods detected");
    return;
  }

  const sourceId =
    window.filter((r) => r.role === "user").slice(-1)[0]?.id ?? null;

  let savedCount = 0;
  let pendingCount = 0;
  for (const food of foods) {
    if (typeof food.confidence !== "number" || food.confidence < CONFIDENCE_THRESHOLD) {
      console.log(`[food-extract] skip food: confidence=${food.confidence} < ${CONFIDENCE_THRESHOLD}`);
      continue;
    }
    if (!Array.isArray(food.items) || food.items.length === 0) continue;

    // raw_text 完全一致 dedup (= LLM が見逃した時の最終保険、cheap)
    const dupKey = food.raw_text_excerpt?.trim().slice(0, 80) ?? "";
    if (dupKey) {
      const dups = await db
        .select({ id: foodLogs.id })
        .from(foodLogs)
        .where(eq(foodLogs.rawText, dupKey))
        .limit(1);
      if (dups.length > 0 && dups[0].id > 0) {
        console.log(`[food-extract] dup skip (raw_text match): id=${dups[0].id}`);
        continue;
      }
    }

    // user が kcal/PFC/salt を会話で明示していたら status=manual_user で保存
    const hasUserNutrition =
      typeof food.user_kcal === "number" ||
      typeof food.user_protein === "number" ||
      typeof food.user_carbs === "number" ||
      typeof food.user_fat === "number" ||
      typeof food.user_fiber === "number" ||
      typeof food.user_salt === "number";

    const items = food.items.map((it) => ({
      name: it.name,
      quantity: typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : 1,
      unit: it.unit ?? "",
      kcal: null as number | null,
      protein: null as number | null,
      carbs: null as number | null,
      fat: null as number | null,
      fiber: null as number | null,
      salt: null as number | null,
    }));

    await db.insert(foodLogs).values({
      eatenAt: parseEatenAt(food.eaten_at_iso),
      rawText: dupKey,
      items,
      totalKcal: hasUserNutrition ? food.user_kcal ?? null : null,
      totalProtein: hasUserNutrition ? food.user_protein ?? null : null,
      totalCarbs: hasUserNutrition ? food.user_carbs ?? null : null,
      totalFat: hasUserNutrition ? food.user_fat ?? null : null,
      totalFiber: hasUserNutrition ? food.user_fiber ?? null : null,
      totalSalt: hasUserNutrition ? food.user_salt ?? null : null,
      sourceMessageId: sourceId,
      notes: food.notes?.trim() || null,
      confidence: food.confidence,
      nutritionStatus: hasUserNutrition ? "manual_user" : "pending",
    });
    savedCount++;
    if (!hasUserNutrition) pendingCount++;
  }

  if (savedCount > 0) {
    console.log(
      `[food-extract] saved ${savedCount} food(s) (${pendingCount} pending for nutrition fill)`
    );
    // pending 行は別 worker が fill する (Phase 3 で実装)
    if (pendingCount > 0) {
      void kickNutritionFillWorker().catch((e) =>
        console.warn("[food-extract] nutrition worker kick failed:", e)
      );
    }
  }
}

/**
 * primary (= local Gemma if enabled, else haikuModel) で叩いて失敗したら
 * AI 設定の sub model (= haikuModel) で 1 度だけフォールバック。
 */
async function callExtractWithFallback(userMsg: string): Promise<Anthropic.Message> {
  try {
    return await callLlm("food_extract", {
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: 700,
      retry: true,
    });
  } catch (primaryErr) {
    console.warn(
      "[food-extract] primary failed, fallback to sub model:",
      primaryErr instanceof Error ? primaryErr.message : primaryErr
    );
    const cfg = await getAnthropicConfig();
    return await callLlm("food_extract", {
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: 700,
      model: cfg.haikuModel,
      retry: true,
    });
  }
}

/** Phase 3 の nutrition fill worker が import する placeholder。後で実装 */
async function kickNutritionFillWorker(): Promise<void> {
  try {
    const { kickFillWorker } = await import("@/lib/food-nutrition-worker");
    await kickFillWorker();
  } catch {
    // worker 未実装 / import 失敗時は no-op (pending 行は次回 worker 起動時に拾われる)
  }
}

/**
 * メトリクス保存 (体重 / 体脂肪 / 気分)。
 * 同 metric_type で直近 6h 以内に同じ value があれば dedup skip。
 */
async function saveMetrics(
  metrics: MetricPart[],
  window: Array<{ id: number; role: string; createdAt: Date }>
): Promise<void> {
  if (metrics.length === 0) return;
  const sourceId =
    window.filter((r) => r.role === "user").slice(-1)[0]?.id ?? null;
  for (const m of metrics) {
    if (typeof m.value !== "number" || !Number.isFinite(m.value)) continue;
    if (typeof m.metric_type !== "string") continue;
    if (typeof m.confidence !== "number" || m.confidence < CONFIDENCE_THRESHOLD) continue;
    if (m.metric_type === "weight_kg" && (m.value < 20 || m.value > 300)) continue;
    if (m.metric_type === "body_fat_pct" && (m.value < 3 || m.value > 60)) continue;
    if (m.metric_type === "mood_1to5" && (m.value < 1 || m.value > 5)) continue;

    const recordedAt = parseEatenAt(m.recorded_at_iso);
    const since = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const dups = await db
      .select({ id: bodyMetrics.id })
      .from(bodyMetrics)
      .where(
        and(
          eq(bodyMetrics.metricType, m.metric_type),
          eq(bodyMetrics.value, m.value),
          gte(bodyMetrics.recordedAt, since)
        )
      )
      .limit(1);
    if (dups.length > 0) {
      console.log(`[food-extract] metric dedup skip: ${m.metric_type}=${m.value}`);
      continue;
    }
    await db.insert(bodyMetrics).values({
      metricType: m.metric_type,
      value: m.value,
      recordedAt,
      source: "extracted",
      sourceMessageId: sourceId,
    });
    console.log(`[food-extract] metric saved: ${m.metric_type}=${m.value} @ ${recordedAt.toISOString()}`);
  }
}

// ───── helpers ─────

function jstNow(): string {
  return formatJst(new Date());
}

function formatJst(d: Date): string {
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  const parts = fmt.formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${g("year")}-${g("month")}-${g("day")} ${g("hour")}:${g("minute")}:${g("second")}`;
}

function parseEatenAt(iso: string | undefined): Date {
  if (!iso || typeof iso !== "string") return new Date();
  const hasTz = /(?:Z|[+\-]\d{2}:?\d{2})$/.test(iso.trim());
  const normalized = hasTz ? iso : `${iso}+09:00`;
  const d = new Date(normalized);
  if (Number.isNaN(d.getTime())) return new Date();
  return d;
}

function parseJsonLoose(text: string): ExtractResult | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as ExtractResult;
  } catch {
    return null;
  }
}
