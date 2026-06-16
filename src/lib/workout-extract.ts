/**
 * 会話から筋トレ / 運動ログを「即時 post-turn」で抽出して workout_logs に保存する。
 *
 * v2 (2026-06-06〜) 設計変更点 (= food-extract.ts v2 と同方針):
 *   - 旧: 5 分 debounce → 全文 50 件一括抽出 → 文字列完全一致 dedup
 *         (= 同じ運動を別言い回しで複数回言うと重複登録の事故)
 *   - 新: chat/route から fire-and-forget で即時 trigger
 *         → 直近 user/assistant のみ + 直近 10 件 (48h) を context として LLM に渡し
 *         → LLM が「既登録の運動」を自分で除外
 *         → 同伴者/場所/印象 等の付帯情報を notes に抽出
 *   - primary は callLlm("food_extract") = AI 設定で local LLM (Gemma 等) が有効なら
 *     ローカル経路、それ以外なら haikuModel。failure 時はユーザ指定 sub model (haikuModel) で
 *     1 度だけフォールバック。
 *
 * 食事と違って kcal/PFC lookup は不要なので、nutrition_status / fill worker は持たない。
 *
 * private モード会話は raw_messages に書かれないので chat/route 側で trigger しないだけで自動除外。
 */
import { db } from "@/db/client";
import { rawMessages, workoutLogs } from "@/db/schema";
import { and, eq, desc, gte } from "drizzle-orm";
import { callLlm } from "@/lib/llm";
import type Anthropic from "@anthropic-ai/sdk";

const CONFIDENCE_THRESHOLD = 0.7;
const RECENT_WORKOUTS_WINDOW_HOURS = 48;
const RECENT_WORKOUTS_LIMIT = 10;

// 運動言及がない発話は LLM 呼ばない (= cost 削減)
const WORKOUT_SIGNAL_RE =
  /ジム|トレ|筋トレ|ワークアウト|ベンチ|デッド|スクワット|懸垂|プレス|カール|レッグ|ラン(?:ニング)?|走っ|走り|ジョギ|サイクリ|自転車|水泳|プール|エアロ|有酸素|上半身|下半身|胸|背中|肩(?:[^幅])|腕(?:立て)?|脚|腹筋|体幹|腹斜|セット|レップ|RM/u;

const SYSTEM_PROMPT = `あなたはご主人様の会話から、筋トレ / 運動 ログを抽出する係です。

# 検出条件
- 過去〜現在進行の運動 → workouts 配列に追加 (例「今日ジム行ってきた」「ベンチプレス 80kg 5x3」「5km 走った」)
- 未来の予定 / 一般論 / 他人の話 → 除外
- 「ジム会員」「ジムどこにしよう」等の話題化のみ → 除外

# 🚨 重複登録の禁止 (最重要)
"## 既に登録済みの運動" セクションに同じ運動 (同じ body_parts + 概ね同じ時刻) があれば
**workouts から完全に除外**してください。同じ「胸トレ」を 2 度言っても 1 ログのままにする。
逆に「朝ラン → 夜筋トレ」みたいに本当に別タイミングで 2 度やった場合は 2 ログにする。
判断材料: performed_at が 3 時間以上離れていれば別の運動、近ければ同じ運動。

# body_parts (英語短縮形で配列)
chest (胸) / back (背中) / shoulders (肩) / legs (脚) / arms (腕・上腕・前腕・三頭・二頭) / core (腹・体幹) / cardio (有酸素・ランニング・自転車・水泳) / full (全身・サーキット)
日本語表現を必ず英語短縮形に正規化:
- 「胸と三頭」 → ["chest", "arms"]
- 「下半身」 → ["legs"]
- 「上半身全部」 → ["chest", "back", "shoulders", "arms"]
- 「5km ラン」 → ["cardio"]

# exercises
個別種目を分かる範囲で。データが無ければ name だけでよい。
[
  { "name": "ベンチプレス", "sets": 3, "reps": 5, "weight_kg": 80 },
  { "name": "ランニング", "distance_km": 5, "duration_min": 30 }
]

# intensity
"light" (軽め / 流し) / "normal" (普通) / "hard" (追い込んだ / きつかった)。不明なら null。

# notes (任意 string)
発話から運動以外の付帯情報を拾って 1-2 文で要約。誰と / どこで / 印象 / シーン等。
例: "同僚と帰り際にジム"、"久しぶりだったので軽め"、"ベンチ MAX 更新できた"
情報が無ければ省略 (null)。

# 出力 JSON 1 行のみ、装飾やコードフェンス不要

{
  "workouts": [
    {
      "body_parts": string[],
      "exercises": [ ... ],
      "duration_min": number | null,
      "intensity": "light" | "normal" | "hard" | null,
      "performed_at_iso": string,
      "raw_text_excerpt": string,
      "confidence": 0.0〜1.0,
      "notes": string?
    }
  ]
}

## performed_at_iso の決め方
1. 文中に明示時刻 ("朝 7 時に" "夜トレ") → そのまま採用 (JST)
2. "今 / さっき / たった今 / 帰ってきた" → 会話時刻
3. 単に「今日ジム」→ その日の 19:00 (帰宅後想定)
4. "昨日ジム" → 前日 19:00
5. 不明 → 会話時刻`;

type WorkoutPart = {
  body_parts: string[];
  exercises: Array<{
    name: string;
    sets?: number;
    reps?: number;
    weight_kg?: number;
    distance_km?: number;
    duration_min?: number;
  }>;
  duration_min: number | null;
  intensity: "light" | "normal" | "hard" | null;
  performed_at_iso: string;
  raw_text_excerpt: string;
  confidence: number;
  notes?: string;
};

type ExtractResult = {
  workouts: WorkoutPart[];
};

const VALID_BODY_PARTS = new Set([
  "chest", "back", "shoulders", "legs", "arms", "core", "cardio", "full",
]);

/**
 * chat/route から fire-and-forget で呼ばれる即時抽出 entry point。
 * 旧 scheduleWorkoutExtract と互換シグネチャ (= 引数 sessionId のみ)。
 */
export async function scheduleWorkoutExtract(sessionId: string): Promise<void> {
  await extractWorkoutFromSession(sessionId);
}

/** デバッグ / 手動 trigger 用 (= scheduleWorkoutExtract と同等の即時実行) */
export async function runWorkoutExtractNow(sessionId: string): Promise<void> {
  await extractWorkoutFromSession(sessionId);
}

async function extractWorkoutFromSession(sessionId: string): Promise<void> {
  // 直近 4 件 (= 1-2 turn pair) のみ取得。前ターン以前は extract 済として扱う。
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
  if (!WORKOUT_SIGNAL_RE.test(userText)) return;

  // 直近 48h の workout_logs (= LLM に「既登録」として渡して重複登録を抑制)
  const sinceWindow = new Date(Date.now() - RECENT_WORKOUTS_WINDOW_HOURS * 60 * 60 * 1000);
  const recentWorkouts = await db
    .select({
      id: workoutLogs.id,
      performedAt: workoutLogs.performedAt,
      bodyParts: workoutLogs.bodyParts,
      exercises: workoutLogs.exercises,
    })
    .from(workoutLogs)
    .where(gte(workoutLogs.performedAt, sinceWindow))
    .orderBy(desc(workoutLogs.performedAt))
    .limit(RECENT_WORKOUTS_LIMIT);

  const recentSummary =
    recentWorkouts.length > 0
      ? recentWorkouts
          .map((w) => {
            const parts = Array.isArray(w.bodyParts)
              ? (w.bodyParts as string[]).join(", ")
              : "?";
            const exNames = Array.isArray(w.exercises)
              ? (w.exercises as Array<{ name?: string }>)
                  .map((e) => e.name ?? "?")
                  .slice(0, 3)
                  .join(", ")
              : "";
            return `- ${formatJst(w.performedAt)} : [${parts}]${exNames ? " — " + exNames : ""}`;
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
    `## 既に登録済みの運動 (直近 ${RECENT_WORKOUTS_WINDOW_HOURS}h, 最大 ${RECENT_WORKOUTS_LIMIT} 件)`,
    recentSummary,
    "",
    "## 今回の会話 (古→新)",
    context,
    "",
    "上記から、新規の運動ログを抽出して JSON 1 行で返してください。既登録と同じ運動は除外。",
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
      "[workout-extract] primary + fallback both failed:",
      e instanceof Error ? e.message : e
    );
    return;
  }
  if (!parsed) {
    console.warn("[workout-extract] LLM returned no parseable JSON");
    return;
  }

  const workouts: WorkoutPart[] = Array.isArray(parsed.workouts) ? parsed.workouts : [];
  if (workouts.length === 0) {
    console.log("[workout-extract] no new workouts detected");
    return;
  }

  const sourceId =
    window.filter((r) => r.role === "user").slice(-1)[0]?.id ?? null;

  let savedCount = 0;
  for (const w of workouts) {
    if (typeof w.confidence !== "number" || w.confidence < CONFIDENCE_THRESHOLD) {
      console.log(`[workout-extract] skip: confidence=${w.confidence} < ${CONFIDENCE_THRESHOLD}`);
      continue;
    }

    // body_parts 正規化 (未知の値は捨てる)
    const bodyParts = Array.isArray(w.body_parts)
      ? w.body_parts.filter((p) => typeof p === "string" && VALID_BODY_PARTS.has(p))
      : [];
    if (bodyParts.length === 0) {
      console.log(
        `[workout-extract] skip: no valid body_parts (got ${JSON.stringify(w.body_parts)})`
      );
      continue;
    }

    // raw_text 完全一致 dedup (= LLM が見逃した時の最終保険)
    const dupKey = w.raw_text_excerpt?.trim().slice(0, 80) ?? "";
    if (dupKey) {
      const since3h = new Date(Date.now() - 3 * 60 * 60 * 1000);
      const dups = await db
        .select({ id: workoutLogs.id })
        .from(workoutLogs)
        .where(and(eq(workoutLogs.rawText, dupKey), gte(workoutLogs.performedAt, since3h)))
        .limit(1);
      if (dups.length > 0 && dups[0].id > 0) {
        console.log(`[workout-extract] dup skip (raw_text match): id=${dups[0].id}`);
        continue;
      }
    }

    const exercises = Array.isArray(w.exercises) ? w.exercises : [];
    const intensity =
      w.intensity && ["light", "normal", "hard"].includes(w.intensity) ? w.intensity : null;
    const performedAt = parsePerformedAt(w.performed_at_iso);

    await db.insert(workoutLogs).values({
      performedAt,
      bodyParts,
      exercises,
      durationMin: typeof w.duration_min === "number" ? Math.round(w.duration_min) : null,
      intensity,
      notes: w.notes?.trim() || null,
      rawText: dupKey || (w.raw_text_excerpt ?? ""),
      sourceMessageId: sourceId,
      confidence: w.confidence,
    });
    savedCount++;
  }

  if (savedCount > 0) {
    console.log(`[workout-extract] saved ${savedCount} workout(s)`);
  }
}

/**
 * food_extract role で抽出。local 失敗時の hosted fallback は #206 M3 の tier fallback
 * (model_tier_fallback.sub) が担うので、ここでは手書き fallback を持たない。
 */
async function callExtractWithFallback(userMsg: string): Promise<Anthropic.Message> {
  return await callLlm("food_extract", {
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMsg }],
    maxTokens: 700,
    retry: true,
  });
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

function parsePerformedAt(iso: string | undefined): Date {
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
