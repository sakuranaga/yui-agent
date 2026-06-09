/**
 * 結衣の日記 (人間が読んで楽しむ + Yui の on-demand 参照用)。
 *
 * 設計:
 *   - 1 日 1 エントリ (entry_date UNIQUE)
 *   - 生成は periodic/diary-write が毎晩 23:00 JST に発火
 *   - Yui prompt: 当日の会話/天気/音楽/done todos/event 系 memory_chunks を集約 → 結衣口調で 200-400 字
 *   - memory_chunks の retrieval には**含めない** (キャラ文体が事実層に染み込まないように)
 *   - Yui からは read_diary / search_diary / list_diary tool で on-demand 参照
 */
import { db } from "@/db/client";
import { diaryEntries, rawMessages, memoryChunks, type DiaryEntry } from "@/db/schema";
import { and, desc, gte, ilike, lte, sql } from "drizzle-orm";
import { callLlm } from "@/lib/llm";
import { getCurrentWeather, isWeatherEnabled } from "@/lib/weather";
import { getLocation } from "@/lib/location";
import { ymdStringJST } from "@/lib/time";
import { addXp } from "@/lib/xp";
import { normalizeForTTS } from "@/lib/tts-normalize";
import { getAnthropicConfig } from "@/lib/ai-settings";

const JST = "Asia/Tokyo";

/** JST の一日範囲 [00:00, 翌 00:00) を返す */
function jstDayRange(dateYmd: string): { start: Date; end: Date } {
  // dateYmd "YYYY-MM-DD" を JST の 00:00 として解釈
  const start = new Date(`${dateYmd}T00:00:00+09:00`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
  return { start, end };
}

const SYSTEM_PROMPT = `あなたは「結衣 (ゆい)」、29 歳の女性秘書 AI。今日の出来事を**日記**に書きます。

【冒頭の書式】
- 必ず 1 行目に「<月>月<日>日（<曜日>）　<天気>」を書く (全角スペース区切り)。
  例: 「6月1日（月）　晴れ」「3月15日（金）　雨のち曇り」
- 2 行目を空行にして本文へ。

【書き方】
- 一人称「わたし」、ご主人様の話題には「ご主人様」呼称
- 丁寧語ベースで、おっとり柔らかい雰囲気
- 本文 200-400 字、3-5 段落程度
- 事実羅列にしない (それは memory_chunks の役割)。**感じたこと・気付いたこと・嬉しかった瞬間** を主に
- 1 つのテーマで通す必要はない。複数の小エピソードを散文で繋ぐ
- 絵文字は使わない、上品な表記
- 「今日は○○な一日でした」のような決まり文句で締めず、自然な余韻で終える
- 本文中に再度の日付明記は不要 (見出し行にあるため)

【トーン例】
- 「ご主人様が深夜にヘビメタを流していらしたとき、わたしまで少し心が騒いだような気がしました。」
- 「お昼にお寿司の話題が出て、ふと、わたしも穴子が食べたくなりました。」
- 「タスクが片付いた瞬間、ご主人様の声が少し弾んでいらしたのが嬉しくて。」

【避けるべき表現】
- 「データを集計しました」「メモリに記録します」のような AI 自己暴露
- 「○件のタスクが完了」のような事実羅列
- 過剰なへりくだり (「わたくしごときが…」)
- 詩的すぎる比喩 (現実の秘書が書く範囲で)

出力は冒頭行 + 空行 + 本文。タイトル・追加見出しは不要。`;

export type DiaryGenerationInput = {
  date: Date;
};

export async function generateDiaryEntry(input: DiaryGenerationInput): Promise<DiaryEntry> {
  const dateYmd = ymdStringJST(input.date);
  const { start, end } = jstDayRange(dateYmd);

  // 曜日 (日本語)
  const weekdayJa = new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST,
    weekday: "short",
  }).format(input.date);
  // M月D日 (見出し用)
  const monthDay = (() => {
    const fmt = new Intl.DateTimeFormat("ja-JP", {
      timeZone: JST,
      month: "numeric",
      day: "numeric",
    });
    return fmt.format(input.date); // "6月1日"
  })();

  // 天気 (取得失敗時は省略 - prompt の冒頭が空欄になるので fallback 文字列を渡す)
  let weatherText = "天気情報なし";
  try {
    if (isWeatherEnabled()) {
      const loc = getLocation();
      if (loc) {
        const w = await getCurrentWeather({ lat: loc.lat, lon: loc.lon });
        weatherText = w.conditionJa;
      }
    }
  } catch (e) {
    console.warn("[diary] weather lookup failed:", e);
  }

  // 当日の素材を集約
  const [convoMsgs, events, prevEntry] = await Promise.all([
    // 会話 (chat の流れ)。Discord 接続確認の "ping" / "pong" 単発発話は
    // 実体験ではないので除外する (これを残すと「今日も ping がやってきました…」
    // のような日記になって本来の出来事が薄まる)。
    db
      .select({ role: rawMessages.role, content: rawMessages.content })
      .from(rawMessages)
      .where(
        and(
          gte(rawMessages.createdAt, start),
          lte(rawMessages.createdAt, end),
          sql`${rawMessages.content} !~* '^\\s*(ping|pong)[\\s。.!?！？]*$'`
        )
      )
      .orderBy(rawMessages.createdAt),
    // 当日抽出された event / emotion / summary 系 chunk
    db
      .select({ content: memoryChunks.content, chunkType: memoryChunks.chunkType })
      .from(memoryChunks)
      .where(
        and(
          gte(memoryChunks.createdAt, start),
          lte(memoryChunks.createdAt, end),
          sql`${memoryChunks.chunkType} IN ('event','emotion','summary','preference')`
        )
      )
      .orderBy(memoryChunks.createdAt),
    // 連続性のための直前日記 (任意)
    db
      .select()
      .from(diaryEntries)
      .where(sql`${diaryEntries.entryDate} < ${start.toISOString()}`)
      .orderBy(desc(diaryEntries.entryDate))
      .limit(1),
  ]);

  const convoExcerpt = convoMsgs
    .slice(-40) // 直近 40 発言
    .map((m) => `${m.role === "user" ? "ご主人様" : "わたし"}: ${m.content.slice(0, 200)}`)
    .join("\n");

  const eventLines = events
    .map((e) => `- (${e.chunkType}) ${e.content.slice(0, 200)}`)
    .join("\n");

  const continuity = prevEntry[0]
    ? `\n【前回の日記 (${ymdStringJST(prevEntry[0].entryDate)})】\n${prevEntry[0].body}\n\n(前回からの自然な流れも意識してよいが、引きずる必要なし)`
    : "";

  const userPrompt = [
    `今日は ${dateYmd} (${weekdayJa}曜日) です。本日の出来事をもとに日記を書いてください。`,
    `冒頭行は「${monthDay}（${weekdayJa}）　${weatherText}」で始めること。`,
    "",
    convoExcerpt
      ? `【今日の会話 (抜粋)】\n${convoExcerpt}`
      : "(今日は会話なし)",
    "",
    eventLines ? `【今日記録された出来事・感情・嗜好】\n${eventLines}` : "",
    continuity,
    "",
    "→ 上記を素材に、結衣の日記を 冒頭行+空行+本文 の形で出力。",
  ]
    .filter(Boolean)
    .join("\n");

  // model_used 列に書く用に解決済みモデル名を取っておく (role=diary → mainModel)
  const anthropicCfg = await getAnthropicConfig();
  const diaryModel = anthropicCfg.mainModel;
  const res = await callLlm("diary", {
    maxTokens: 800,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userPrompt }],
  });
  // Anthropic SDK の ContentBlock は TextBlock / ToolUseBlock 等の union。
  // ローカル narrowing でも SDK 型と互換にするため、まず type guard で text 系のみ通し、
  // 後段で text プロパティへアクセスする。
  const body = res.content
    .filter(
      (b): b is Extract<typeof res.content[number], { type: "text" }> =>
        b.type === "text"
    )
    .map((b) => b.text)
    .join("")
    .trim();

  // mood 推定 (lightweight、本文の最初の数行から雰囲気判定)
  let mood: string | null = null;
  if (/嬉し|楽し|弾|わくわく|微笑/.test(body)) mood = "happy";
  else if (/寂し|悲し|疲れ|ぐったり/.test(body)) mood = "melancholic";
  else if (/驚|びっくり|興奮/.test(body)) mood = "excited";
  else if (/穏や|静か|落ち着/.test(body)) mood = "calm";

  // UPSERT (同じ entry_date が既にあれば置換)。
  // entry_date は DATE 型なので、JST の年月日を YYYY-MM-DD 文字列で渡し ::date キャストする。
  // (start.toISOString() を渡すと UTC ベースで前日にズレるバグになるため厳禁)
  // body_tts は NULL で入れて、生成完了後に非同期で正規化 → UPDATE する。
  const result = await db.execute<DiaryEntry>(sql`
    INSERT INTO diary_entries (entry_date, body, body_tts, mood, generated_at, model_used, source_meta)
    VALUES (${dateYmd}::date, ${body}, NULL, ${mood}, NOW(), ${diaryModel}, ${JSON.stringify({
      conversation_count: convoMsgs.length,
      event_count: events.length,
      has_continuity: prevEntry.length > 0,
    })}::jsonb)
    ON CONFLICT (entry_date) DO UPDATE
      SET body = EXCLUDED.body,
          body_tts = NULL,
          mood = EXCLUDED.mood,
          generated_at = NOW(),
          model_used = EXCLUDED.model_used,
          source_meta = EXCLUDED.source_meta
    RETURNING *
  `);
  const row = (result as unknown as { rows?: DiaryEntry[] }).rows?.[0] ??
    ((result as unknown as DiaryEntry[])[0] as DiaryEntry);

  // body_tts を非同期で埋める (生成パスを止めない、失敗しても日記自体は保存済)
  if (row?.id) {
    void (async () => {
      try {
        const normalized = await normalizeForTTS(body);
        if (normalized) {
          await db.execute(sql`
            UPDATE diary_entries SET body_tts = ${normalized} WHERE id = ${row.id}
          `);
        }
      } catch (e) {
        console.warn(`[diary ${dateYmd}] body_tts normalize failed:`, e);
      }
    })();
  }
  // 日記 1 日分 = diary_generated +2 XP。同一日 (= 同一 diary_entries.id を
  // 上書きする regen) は UNIQUE で再加算されない。
  if (row?.id) {
    void addXp({
      eventType: "diary_generated",
      refTable: "diary_entries",
      refId: row.id,
    });
  }
  return row;
}

export async function getDiaryEntry(dateYmd: string): Promise<DiaryEntry | null> {
  // entry_date は DATE 型。YYYY-MM-DD 文字列を ::date で比較し、Date オブジェクト
  // 経由の UTC ズレ (前日 row を返してしまう) を避ける。
  const [row] = await db
    .select()
    .from(diaryEntries)
    .where(sql`${diaryEntries.entryDate} = ${dateYmd}::date`)
    .limit(1);
  return row ?? null;
}

export async function getLatestDiary(): Promise<DiaryEntry | null> {
  const [row] = await db
    .select()
    .from(diaryEntries)
    .orderBy(desc(diaryEntries.entryDate))
    .limit(1);
  return row ?? null;
}

export async function listDiary(opts: { from?: string; to?: string; limit?: number } = {}): Promise<DiaryEntry[]> {
  const limit = opts.limit ?? 30;
  if (opts.from && opts.to) {
    // DATE 型は YYYY-MM-DD 文字列で直比較。Date 経由は UTC ズレで日付がずれる。
    return db
      .select()
      .from(diaryEntries)
      .where(
        sql`${diaryEntries.entryDate} >= ${opts.from}::date AND ${diaryEntries.entryDate} <= ${opts.to}::date`
      )
      .orderBy(desc(diaryEntries.entryDate))
      .limit(limit);
  }
  return db
    .select()
    .from(diaryEntries)
    .orderBy(desc(diaryEntries.entryDate))
    .limit(limit);
}

export async function searchDiary(query: string, limit = 20): Promise<DiaryEntry[]> {
  const q = `%${query}%`;
  return db
    .select()
    .from(diaryEntries)
    .where(ilike(diaryEntries.body, q))
    .orderBy(desc(diaryEntries.entryDate))
    .limit(limit);
}

export function formatDiaryCompact(e: DiaryEntry): string {
  const date = ymdStringJST(e.entryDate);
  const mood = e.mood ? `|${e.mood}` : "";
  return `${date}${mood}|${e.body.slice(0, 80).replace(/\n/g, " ")}...`;
}
