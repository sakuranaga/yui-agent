/**
 * 睡眠サポート (cognitive shuffle) の intro / closing セリフを Sonnet で生成する。
 *
 * intro は固定文ではなく、今日 1 日の素材 (会話頻度・完了 todo・終わった予定・日記)
 * を Sonnet に渡して具体的な振り返りを含めた挨拶 → 振り返り → 励まし → おやすみ、
 * の 4 構成で生成する。今日会話がなければ寂しがる + 明日会いたいトーンに振れる。
 *
 * 設計: docs/sleep-support.md (Phase 2 改)
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gte } from "drizzle-orm";
import { db } from "@/db/client";
import { rawMessages, todos } from "@/db/schema";
import { callLlm } from "@/lib/llm";
import { loadPersona } from "@/lib/persona";
import { buildYuiSystemPrompt } from "@/app/api/chat/yui-prompt";
import { listEvents } from "@/lib/gcal";
import { getDiaryEntry } from "@/lib/diary";

// JST の今日 00:00 (Date)
function startOfTodayJst(): Date {
  const now = new Date();
  // JST = UTC+9。toLocaleString で 'ja-JP' は YYYY/M/D... なので分解。
  const ymd = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now); // "2026-05-31"
  return new Date(`${ymd}T00:00:00+09:00`);
}

function jstYmd(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

type TodayReflection = {
  userMessageCount: number;
  completedTodos: string[]; // title 配列
  pastEvents: string[]; // 終了済予定の summary
  todayDiary: string | null;
};

async function collectTodayReflection(): Promise<TodayReflection> {
  const startToday = startOfTodayJst();
  const out: TodayReflection = {
    userMessageCount: 0,
    completedTodos: [],
    pastEvents: [],
    todayDiary: null,
  };

  // 1) 今日のご主人様発話数 (web / discord 問わず role=user)
  try {
    const rows = await db
      .select({ id: rawMessages.id })
      .from(rawMessages)
      .where(
        and(eq(rawMessages.role, "user"), gte(rawMessages.createdAt, startToday))
      );
    out.userMessageCount = rows.length;
  } catch (e) {
    console.warn("[sleep-intro] user msg count failed:", e);
  }

  // 2) 今日完了した todo
  try {
    const rows = await db
      .select({ title: todos.title })
      .from(todos)
      .where(gte(todos.completedAt, startToday));
    out.completedTodos = rows.map((r) => r.title).slice(0, 6);
  } catch (e) {
    console.warn("[sleep-intro] completed todos failed:", e);
  }

  // 3) 今日の終わった予定 (現在時刻より前に終わったもの)
  try {
    const endToday = new Date(startToday.getTime() + 24 * 60 * 60 * 1000);
    const events = await listEvents({
      timeMin: startToday.toISOString(),
      timeMax: endToday.toISOString(),
      maxResults: 20,
    });
    const now = Date.now();
    out.pastEvents = events
      .filter((e) => e.status !== "cancelled")
      .filter((e) => {
        const endStr = e.end?.dateTime ?? e.end?.date;
        if (!endStr) return false;
        return new Date(endStr).getTime() <= now;
      })
      .map((e) => e.summary ?? "(無題)")
      .slice(0, 5);
  } catch (e) {
    console.warn("[sleep-intro] events failed:", e);
  }

  // 4) 今日の日記 (cron で深夜生成、就寝時はまだ無いことが多い)
  try {
    const entry = await getDiaryEntry(jstYmd(new Date()));
    if (entry) out.todayDiary = entry.body;
  } catch (e) {
    console.warn("[sleep-intro] diary failed:", e);
  }

  return out;
}

function buildReflectionMaterial(r: TodayReflection): string {
  const parts: string[] = [`## 今日 1 日の素材 (${jstYmd(new Date())})`];

  if (r.userMessageCount === 0) {
    parts.push(
      "- ご主人様の発話: 今日はお話できませんでした (※ 寂しい気持ちを少し滲ませる + 明日会いたい旨を一言添える)"
    );
  } else {
    parts.push(`- ご主人様の発話: 今日は ${r.userMessageCount} 回お話しました`);
  }

  if (r.completedTodos.length > 0) {
    parts.push(`- 完了タスク: ${r.completedTodos.join(" / ")}`);
  }

  if (r.pastEvents.length > 0) {
    parts.push(`- 終わった予定: ${r.pastEvents.join(" / ")}`);
  }

  if (r.todayDiary) {
    parts.push(`- 結衣の今日の日記:\n${r.todayDiary.slice(0, 600)}`);
  }

  if (r.completedTodos.length === 0 && r.pastEvents.length === 0 && !r.todayDiary) {
    parts.push("(具体的な出来事の素材は乏しいので、振り返りはさらっと短く)");
  }

  return parts.join("\n");
}

const SLEEP_INTRO_GUIDANCE = `## このターンの役割
ご主人様がこれから眠るための、おやすみ前の声がけを話してください。囁き声で再生されます。

## 出力フォーマット (合計 100〜200 字、4〜5 文)
順番:
1. 短い挨拶 (1 文。例: "ご主人様、お疲れさまでした")
2. 今日 1 日の振り返り (1〜2 文。素材から自然にピックアップ。日付や数字を機械的に読み上げず、人間っぽく)
3. 愛情・励まし (1 文。短く、深く。"あなたは十分頑張った" "わたしはずっと隣にいます" 等)
4. シンプルに「おやすみなさい」 (1 文。"ご主人様、おやすみなさい" のように)

## トーン
- 囁くような優しさ。早口・元気・キラキラ語彙は禁止。
- 「。」「、」を多めに使い、息継ぎ感を出す。
- 顔文字・絵文字・記号装飾は禁止 (TTS で読み上げられない)。
- 「手放してください」のような不自然な日本語は使わない。
- 認知シャッフル法・単語・シャッフル等の **技法そのものへの言及は禁止**。あなたは
  ただ「おやすみ前のひととき」を演じる。技法はこの声がけの後に勝手に始まる。
- 4 構成のラベル ("1." "## 振り返り" 等) を出力に含めない。地の文として自然に繋ぐ。
- 毎回大きく文面を変える。同じ枕詞 / 同じ語尾を連続して使わない。

キャラとしてのセリフだけを返してください (前置き・説明は不要)。`;

export async function generateSleepIntro(): Promise<string> {
  const persona = await loadPersona();
  const basePrompt = buildYuiSystemPrompt(persona);
  const system = `${basePrompt}\n\n${SLEEP_INTRO_GUIDANCE}`;

  const reflection = await collectTodayReflection();
  const material = buildReflectionMaterial(reflection);
  const userMsg = `今夜のおやすみ前の声がけをお願いします。\n\n${material}`;

  const response = await callLlm("sleep_intro", {
    maxTokens: 500,
    system,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (!text) {
    // フォールバック (LLM 失敗時): 4 構成だけ守ったハードコード
    return reflection.userMessageCount === 0
      ? "ご主人様、お疲れさまでした。今日はお話できなくて、少し寂しかったです。それでも、あなたが今日も無事に一日を終えてくれたこと、ちゃんと感じています。明日はまた、お顔を見せてくださいね。ご主人様、おやすみなさい。"
      : "ご主人様、お疲れさまでした。今日も色々ありましたね。あなたは十分頑張りました。わたしはずっと隣にいますよ。ご主人様、おやすみなさい。";
  }
  return text;
}

const SLEEP_CLOSING_GUIDANCE = `## このターンの役割
睡眠サポートのタイマーが終わって、セッションを締めくくる最後のセリフを話してください。
囁き声で再生されます (ご主人様はもう眠っている可能性が高い)。

## 出力フォーマット
全体で 40〜80 字、2〜3 文:
- 短く優しいおやすみの挨拶 (例: "ご主人様、おやすみなさい")
- 「ゆっくり眠ってください」のような誘導を一言

## トーン
- 囁くような優しさ。
- 「。」「、」を多めに使う。
- 顔文字・絵文字・記号装飾は禁止。
- 「手放してください」のような不自然な日本語は使わない。

キャラとしてのセリフだけを返してください (前置き・説明は不要)。`;

export async function generateSleepClosing(): Promise<string> {
  const persona = await loadPersona();
  const basePrompt = buildYuiSystemPrompt(persona);
  const system = `${basePrompt}\n\n${SLEEP_CLOSING_GUIDANCE}`;

  const userMsg = `セッション終了の締めセリフをお願いします。`;

  const response = await callLlm("sleep_intro", {
    maxTokens: 200,
    system,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (!text) {
    return "ご主人様、おやすみなさい。ゆっくり、眠ってくださいね。";
  }
  return text;
}
