/**
 * 記憶の矛盾解決 (background reconciliation)。
 *
 * 新規に挿入された memory_chunks に対して:
 *   1. semantic に近い既存 chunk を取得
 *   2. Claude (Haiku) に「矛盾するか?」判定させる
 *   3. 矛盾あり → 古い chunk を invalidate (削除ではなく flag)
 *
 * extraction が終わった後にバックグラウンドで実行する想定。
 * chat 応答レイテンシには影響しない。
 *
 * 詳細は docs/memory-architecture.md §5.5 参照。
 */
import Anthropic from "@anthropic-ai/sdk";
import { inArray } from "drizzle-orm";
import { db } from "@/db/client";
import { memoryChunks } from "@/db/schema";
import { findSimilarChunks, invalidateChunk, boostImportance } from "@/lib/memory";

import { callLlm } from "@/lib/llm";

/** 矛盾判定: 既存記憶を新規記憶と突き合わせて、対応 verdict を返す */
type ConflictVerdict = {
  id: number;
  verdict: "duplicate" | "supersedes" | "consistent";
  reason: string;
};

const RECONCILE_PROMPT = `あなたは記憶の整合性チェッカーです。

「新しく学んだ情報」と「既存の関連する記憶」を比較し、3 つの verdict から選んでください。

判定ルール:
- **duplicate**: 完全同義、言い換えに過ぎず内容が一致 (= 同じ事実の繰り返し)
  (例: 旧「ユーザーは腕が痛い」 + 新「ユーザーは腕の痛みを抱えている」 → 同じ事実、duplicate)
  (例: 旧「ラーメンが好き」 + 新「ユーザーはラーメンを好む」 → 同じ嗜好、duplicate)
  → NEW chunk は無効化、OLD の importance を boost する (= 「何度も言われた = 重要」と扱う)

- **supersedes**: 同じ対象について事実が**異なる / 反対 / 訂正 / 時系列で変化**
  (例: 旧「腕が痛い」 + 新「腕が治った」 → 反対の状態、supersedes)
  (例: 旧「犬を 3 匹飼っている、タロウ・ハナ・モモ」 + 新「犬は 1 匹、ミロ」 → 別の事実、supersedes)
  → OLD chunk を無効化、NEW chunk を残す (= 「最新の情報で上書き」)

- **consistent**: 補完情報、別側面、関連はあるが矛盾しない
  (例: 旧「コーヒー好き」 + 新「紅茶も飲む」 → 別の事実、両立)
  (例: 旧「腕が痛い」 + 新「腕の痛みとジムの筋肉痛がある」 → 追加情報、両立)
  → 両方残す

【重要】 duplicate と supersedes の違いは「意味が **同じ** か **反対 / 違う** か」。
embedding 類似度だけでは判定できない。文の意味をよく読んで判定すること。

迷ったら **consistent** にしてください。誤って supersedes / duplicate にすると
正しい記憶が失われます。確信があるときだけ supersedes / duplicate にしてください。

出力は JSON 配列のみ。各既存記憶について1要素:
[
  {"id": <chunk_id>, "verdict": "duplicate" | "supersedes" | "consistent", "reason": "<簡潔な根拠>"}
]

JSON のみ出力。説明文・装飾不要。`;

/**
 * 新規挿入された chunk IDs に対して reconciliation を実行。
 * 失敗しても黙って続行 (chat体験に影響させない)。
 */
export async function reconcileNewChunks(newChunkIds: number[]): Promise<void> {
  if (newChunkIds.length === 0) return;

  // 新規 chunks を取得 (embedding 含む)
  const newChunks = await db
    .select()
    .from(memoryChunks)
    .where(inArray(memoryChunks.id, newChunkIds));

  // 並列で各 new chunk について reconcile
  await Promise.allSettled(
    newChunks.map((c) => reconcileOne(c.id, c.content, c.embedding, c.chunkType))
  );
}

async function reconcileOne(
  newChunkId: number,
  newContent: string,
  newEmbedding: number[] | null,
  newChunkType: string
): Promise<void> {
  if (!newEmbedding) return;

  // fact / preference 系のみ厳密チェック。summary や emotion は補完情報として扱う
  if (!["fact", "preference", "procedural", "external_ref"].includes(newChunkType)) {
    return;
  }

  // 類似する既存 chunk を取得 (新 chunk 自身は除外)
  const similar = await findSimilarChunks({
    embedding: newEmbedding,
    excludeIds: [newChunkId],
    minSim: 0.7,
    limit: 5,
    sameTypeAs: newChunkType,
  });

  if (similar.length === 0) return;

  // LLM に判定させる
  const userMsg = [
    `## 新しく学んだ情報`,
    `[NEW] ${newContent}`,
    ``,
    `## 既存の関連する記憶`,
    ...similar.map((s) => `[id: ${s.id}, sim: ${s.score.toFixed(2)}] ${s.content}`),
    ``,
    `各既存記憶について JSON 配列で判定:`,
    `[{"id": N, "verdict": "supersedes"|"consistent", "reason": "..."}]`,
  ].join("\n");

  let response;
  try {
    response = await callLlm("reconcile", {
      maxTokens: 600,
      system: RECONCILE_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });
  } catch (e) {
    console.warn(`[reconcile] LLM call failed for chunk ${newChunkId}:`, e);
    return;
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  let verdicts: ConflictVerdict[];
  try {
    const cleaned = text
      .replace(/^```(?:json)?\s*\n/, "")
      .replace(/\n```\s*$/, "")
      .trim();
    verdicts = JSON.parse(cleaned);
    if (!Array.isArray(verdicts)) throw new Error("not an array");
  } catch (e) {
    console.warn(
      `[reconcile] failed to parse verdict JSON for chunk ${newChunkId}: ${e}\n---raw---\n${text}`
    );
    return;
  }

  // verdict 別に対応:
  //   duplicate  → NEW を invalidate + 同じ意味の OLD を boost (再強化)
  //   supersedes → OLD を invalidate (importance 高くても、矛盾なので)
  //   consistent → 何もしない
  //
  // 複数 verdict 混在時 (例: A は duplicate + B は supersedes) は **両方処理する**:
  //   duplicate と判定された OLD は NEW と同義なので、NEW を消しても情報は失われない。
  //   supersedes と判定された OLD は NEW (= duplicate 対象 OLD) と矛盾するので無効化必須。
  //   旧実装は duplicate 時に supersedes を skip していたが、これは矛盾記憶を残す致命バグ。
  const supersededIds: number[] = [];
  const duplicateIds: number[] = [];
  const similarById = new Map(similar.map((s) => [s.id, s]));

  const duplicateVerdicts = verdicts.filter((v) => v.verdict === "duplicate");
  const supersedesVerdicts = verdicts.filter((v) => v.verdict === "supersedes");

  // duplicate がある → NEW を invalidate + 最 sim の OLD を boost (1 件だけ)
  let winnerId: number | null = null;
  if (duplicateVerdicts.length > 0) {
    const sorted = duplicateVerdicts
      .map((v) => ({ v, sim: similarById.get(v.id)?.score ?? 0 }))
      .sort((a, b) => b.sim - a.sim);
    winnerId = sorted[0].v.id;
    try {
      await invalidateChunk({
        chunkId: newChunkId,
        reason: `duplicate of ${winnerId}: ${sorted[0].v.reason}`,
        invalidatedByChunkId: winnerId,
      });
      await boostImportance({ chunkId: winnerId, delta: 0.05 });
      duplicateIds.push(winnerId);
    } catch (e) {
      console.warn(`[reconcile] duplicate handling failed:`, e);
    }
  }

  // supersedes は duplicate の有無に関わらず別途処理する。
  // NEW が duplicate で無効化されていても、参照は audit trail として残す。
  // ただし LLM が **同一 id について duplicate と supersedes を両方返した** 場合、
  // winnerId (= NEW と同義として boost した OLD) を invalidate すると NEW・OLD 両方
  // ロストする致命バグになるので、winnerId は supersedes 処理から除外する。
  for (const v of supersedesVerdicts) {
    if (winnerId !== null && v.id === winnerId) {
      console.warn(
        `[reconcile] new=${newChunkId}: id=${v.id} に対し LLM が duplicate と supersedes を両方返した。supersedes 側を無視 (winner を保護)`
      );
      continue;
    }
    try {
      await invalidateChunk({
        chunkId: v.id,
        reason: v.reason,
        invalidatedByChunkId: newChunkId,
      });
      supersededIds.push(v.id);
    } catch (e) {
      console.warn(`[reconcile] invalidate ${v.id} failed:`, e);
    }
  }

  if (duplicateIds.length > 0 || supersededIds.length > 0) {
    const parts: string[] = [];
    if (duplicateIds.length > 0) {
      parts.push(`duplicate of [${duplicateIds.join(", ")}] (NEW invalidated, OLD boosted)`);
    }
    if (supersededIds.length > 0) {
      parts.push(`superseded [${supersededIds.join(", ")}]`);
    }
    console.log(
      `[reconcile] new=${newChunkId} (${newChunkType}): ${parts.join("; ")}`
    );
  }
}
