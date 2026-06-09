/**
 * 抽出ロジック: raw_messages を読んで Claude に "覚えておきたい項目" を
 * 抽出させ、memory_chunks に insert。
 *
 * Phase 1: 明示トリガー (isSessionEnd) のみ
 * Phase 3 (前倒し): rolling extraction (10メッセージ毎の自動抽出)
 *
 * 詳細は docs/memory-architecture.md §5 参照。
 * Mem0 v3 パターン: single-pass ADD-only。
 */
import Anthropic from "@anthropic-ai/sdk";
import { and, eq, gt } from "drizzle-orm";
import { db, sql } from "@/db/client";
import {
  extractionProgress,
  memoryChunks,
  rawMessages,
  type NewMemoryChunk,
} from "@/db/schema";
import { embed } from "@/lib/embed";

import { callLlm } from "@/lib/llm";

/** rolling extraction を発火する閾値 (raw_messages の件数). */
export const ROLLING_THRESHOLD = parseInt(
  process.env.ROLLING_EXTRACTION_THRESHOLD ?? "10",
  10
);

type ExtractedItem = {
  type:
    | "fact"
    | "preference"
    | "event"
    | "emotion"
    | "summary";
  /**
   * 記憶の主体:
   *   "user"      = ご主人様の情報
   *   "assistant" = 秘書ペルソナの設定
   *   "shared"    = 両者の共通事実 / 関係性
   * 未指定なら "user" にフォールバック。
   */
  owner?: "user" | "assistant" | "shared";
  content: string;
  importance: number;
};

const EXTRACTION_PROMPT = `以下は AI キャラクターとユーザーの一連の会話の抜粋です。
将来この会話を忘れた状態で会話を再開した場合に「思い出しておきたい項目」を抽出してください。

抽出ルール:
- ユーザーに関する事実 / 好み / 制約は必ず拾う (例: アレルギー、職業、家族構成、趣味、習慣)
- 出来事 (何が起きた、何をした) は日付/時系列のヒント付きで拾う
- 感情パターン (このトピックで嬉しそう、等) を拾う
- 表面的な天気の話、定型的な挨拶は拾わない
- ユーザーが直前に否定/訂正したことは拾わない (例: 「魚アレルギーは嘘だった」と言ったら、魚アレルギーは fact にしない)
- 中立な第三者視点で書く ("ユーザーは…" "秘書は…" "二人は…" と書き、"あなた" "ご主人様" "社長" は使わない)
- 各項目は1〜3文の独立したステートメントにする (将来の検索でヒットしたとき単独で意味が通るように)
- 抜粋全体を俯瞰する短い要約 (type='summary') を1件含めてよい (中身が薄ければ省略可)

【重複抽出の禁止 — 重要】
1 会話の同じ話題を **複数 type にまたがって冗長に出さない**。最も適した 1 つの type だけに集約すること。

× **避けるべき抽出例** (同じ「一緒に散歩したい」を 4 type で重複):
  - summary: "ユーザーと秘書は一緒に散歩したい思いを共有した"
  - fact:    "二人は一緒に歩くことを約束した"
  - emotion: "ユーザーと秘書は一緒に過ごしたいという感情を共有"
  - preference: "ユーザーはゆいと一緒に歩きたい"
  → 4 chunk すべてが「同じ話題の別表現」、retrieval ノイズになる

○ **正しい抽出例**: 上記なら preference 1 件だけ:
  - preference: "ユーザーは秘書と一緒に散歩したいという望みがある"

type 選択の優先順位:
- 持続的な好み / 望みなら preference (1 件で済む)
- 特定の出来事 (今日散歩した、等) なら event
- 一時的な感情 (今この瞬間嬉しい) なら emotion
- 普遍的事実 (家族構成等) なら fact
- 軽い雑談で persistent な意味がなければ何も出さない

冗長 chunk は retrieval を汚し、後の reconcile / decay に余計な負荷をかける。**「1 話題 = 1 chunk」が原則**。

【owner の判定 — 重要】
各項目に「誰についての情報か」を owner で示す:
- "user"      : ご主人様の事実 / 嗜好 / 体験 (大半はこれ)
- "assistant" : 秘書キャラクター側の設定 / 嗜好 (例: 「秘書はコーヒーが好き」「窓辺の花の世話が習慣」)
                 秘書のロールプレイ上の設定情報。ユーザー興味と混同してはいけない
- "shared"    : 両者に関する事実 (例: 「二人は朝コーヒーを一緒に飲む」「最近よく音楽の話をする」)
                 関係性 / 共通体験 / 二人で決めたこと等

迷ったら "user" (デフォルト)。owner を間違えるとニュースキュレーション等で
秘書の好みをユーザー興味として誤読する事故が起こる。

出力は JSON 配列のみ:
[
  {
    "type": "fact" | "preference" | "event" | "emotion" | "summary",
    "owner": "user" | "assistant" | "shared",
    "content": "...",
    "importance": 0.0〜1.0
  }
]

importance の付け方:
- 1.0: アレルギー・健康・約束など忘れると重大
- 0.7: 強い好み、繰り返し語られる関心事
- 0.5: 一般的な情報
- 0.3: 一過性の話題

JSON のみ出力。説明文・コードブロック装飾は不要。拾うものがなければ空配列 [] を返してよい。`;

/** 未抽出メッセージ件数を取得 */
export async function pendingExtractionCount(
  sessionId: string
): Promise<number> {
  const progress = await db
    .select()
    .from(extractionProgress)
    .where(eq(extractionProgress.sessionId, sessionId))
    .limit(1);
  const lastId = progress[0]?.lastExtractedMessageId ?? 0;
  const rows = await sql<[{ count: string }]>`
    SELECT COUNT(*)::text AS count
    FROM raw_messages
    WHERE session_id = ${sessionId} AND id > ${lastId}
  `;
  return parseInt(rows[0].count, 10);
}

/**
 * 指定 session の未抽出 raw_messages から memory items を抽出して
 * memory_chunks に保存。extraction_progress を更新。
 *
 * - `minMessages`: 未抽出メッセージがこの件数未満なら何もしない (rolling のスロットル)
 * - `provisional`: true なら importance を 0.6 にcap、metadata.provisional=true を付与
 *                   (rolling extraction で訂正リスクを下げる)
 *
 * 戻り値: { count: 挿入件数, newChunkIds: 挿入されたchunkのID配列 }
 */
export async function extractIncremental(opts: {
  sessionId: string;
  minMessages?: number;
  provisional?: boolean;
}): Promise<{ count: number; newChunkIds: number[] }> {
  const { sessionId } = opts;
  const minMessages = opts.minMessages ?? 1;
  const provisional = opts.provisional ?? false;

  // 1) 進捗を読む
  const progressRows = await db
    .select()
    .from(extractionProgress)
    .where(eq(extractionProgress.sessionId, sessionId))
    .limit(1);
  const lastId = progressRows[0]?.lastExtractedMessageId ?? 0;

  // 2) 未抽出メッセージを取得
  const turns = await db
    .select()
    .from(rawMessages)
    .where(
      and(eq(rawMessages.sessionId, sessionId), gt(rawMessages.id, lastId))
    )
    .orderBy(rawMessages.id);

  if (turns.length < minMessages) {
    return { count: 0, newChunkIds: [] };
  }

  const latestId = turns[turns.length - 1].id;
  const transcript = turns
    .map((t) => `${t.role.toUpperCase()}: ${t.content}`)
    .join("\n\n");

  // 3) Claude で抽出
  const response = await callLlm("extract", {
    maxTokens: 2000,
    system: EXTRACTION_PROMPT,
    messages: [{ role: "user", content: `会話:\n\n${transcript}` }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let items: ExtractedItem[];
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*\n/, "")
      .replace(/\n```\s*$/, "")
      .trim();
    items = JSON.parse(cleaned);
    if (!Array.isArray(items)) throw new Error("not an array");
  } catch (e) {
    console.error(
      `[extract] failed to parse JSON: ${e}\n---raw---\n${text}\n---`
    );
    // 進捗は更新しない (次回再試行)
    return { count: 0, newChunkIds: [] };
  }

  // 4) 空でも進捗は更新 (同じ範囲を毎回 LLM に投げ続けないため)
  await upsertProgress(sessionId, latestId);

  if (items.length === 0) {
    console.log(
      `[extract] session ${sessionId.slice(0, 8)}: 0 items (range up to ${latestId})`
    );
    return { count: 0, newChunkIds: [] };
  }

  // 5) embed して insert
  const contents = items.map((it) => it.content);
  const embeddings = await embed(contents);

  // 全 candidate を INSERT (dedup は reconcile 側で行う、Phase 4 設計撤回)
  // 理由: embedding only の dedup では「腕が痛い」と「腕が治った」のような意味反転を
  // 区別できないため、LLM 判定が必要。reconcile に集約することで責務を 1 箇所に。
  const rows: NewMemoryChunk[] = items.map((it, i) => {
    const rawImp = Math.max(0, Math.min(1, it.importance ?? 0.5));
    const importance = provisional ? Math.min(rawImp, 0.6) : rawImp;
    const owner: "user" | "assistant" | "shared" =
      it.owner === "assistant" || it.owner === "shared" ? it.owner : "user";
    return {
      sessionId,
      chunkType: it.type,
      owner,
      content: it.content,
      embedding: embeddings[i],
      importance,
      actorType: "extraction",
      actorId: "main_chat",
      metadata: provisional
        ? { provisional: true, extraction_kind: "rolling" }
        : { extraction_kind: "session_end" },
    };
  });

  const inserted = await db
    .insert(memoryChunks)
    .values(rows)
    .returning({ id: memoryChunks.id });
  const newChunkIds = inserted.map((r) => r.id);

  console.log(
    `[extract] session ${sessionId.slice(0, 8)}: ${items.length} items inserted (kind=${provisional ? "rolling" : "session_end"}, range up to ${latestId}, ids=[${newChunkIds.join(",")}])`
  );
  return { count: items.length, newChunkIds };
}

async function upsertProgress(sessionId: string, latestId: number) {
  // ON CONFLICT は Drizzle 標準サポートあるが、生 SQL の方が短い
  await sql`
    INSERT INTO extraction_progress (session_id, last_extracted_message_id, last_extracted_at)
    VALUES (${sessionId}, ${latestId}, NOW())
    ON CONFLICT (session_id)
    DO UPDATE SET
      last_extracted_message_id = EXCLUDED.last_extracted_message_id,
      last_extracted_at         = EXCLUDED.last_extracted_at
  `;
}

/**
 * ユーザー発話に「別れの言葉」が含まれるか判定。
 * セッション末抽出の明示トリガー。
 */
export function isSessionEnd(userMsg: string): boolean {
  return /(ばいばい|バイバイ|またね|また明日|また今度|さようなら|さよなら|おやすみ|お休み|ありがとう、また|失礼します|またあとで)/.test(
    userMsg
  );
}

/** orphan session の判定パラメータ */
const STALE_IDLE_MINUTES = parseInt(
  process.env.STALE_SESSION_IDLE_MINUTES ?? "5",
  10
);
const STALE_MIN_PENDING = parseInt(
  process.env.STALE_SESSION_MIN_PENDING ?? "2",
  10
);

/**
 * 「未抽出のままアイドル化したセッション」を抽出する。
 *
 * 条件:
 *   - 未抽出メッセージが >= STALE_MIN_PENDING (default 2)
 *   - 直近メッセージが STALE_IDLE_MINUTES (default 5) 分以上前
 *
 * これにより rolling threshold (10) に届かなかった短い会話も
 * 一定時間後に必ず抽出される。
 *
 * 戻り値: 抽出したセッション件数 (debug log用)
 */
export async function processStaleSessions(): Promise<number> {
  const rows = await sql<
    Array<{ session_id: string; pending: string; latest_at: Date }>
  >`
    SELECT r.session_id,
           COUNT(*)::text AS pending,
           MAX(r.created_at) AS latest_at
    FROM raw_messages r
    LEFT JOIN extraction_progress p ON r.session_id = p.session_id
    WHERE r.id > COALESCE(p.last_extracted_message_id, 0)
    GROUP BY r.session_id
    HAVING COUNT(*) >= ${STALE_MIN_PENDING}
       AND MAX(r.created_at) < NOW() - (${STALE_IDLE_MINUTES} || ' minutes')::interval
  `;

  if (rows.length === 0) return 0;

  let processed = 0;
  for (const row of rows) {
    try {
      const result = await extractIncremental({
        sessionId: row.session_id,
        minMessages: 1,
        provisional: true, // stale 抽出も rolling 扱い (会話継続なら次のextractで refine)
      });
      console.log(
        `[stale-extract] session ${row.session_id.slice(0, 8)}: pending=${row.pending}, extracted=${result.count} items`
      );
      processed++;
    } catch (e) {
      console.warn(`[stale-extract] session ${row.session_id} failed:`, e);
    }
  }
  return processed;
}
