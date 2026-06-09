/**
 * ご主人様プロファイル スナップショット 生成 / 取得。
 *
 * 設計: docs/user-profile-snapshot.md
 *
 * - 日記 (= 結衣の主観・内面) とは別レコード・別生成パイプ
 * - 日次 (JST 22 時以降 cron で 1 回) で raw_messages + memory_chunks + diary +
 *   body_metrics + todos からデータ駆動の客観プロファイルを Sonnet で生成
 * - Yui の system prompt に最新 snapshot を block として常時注入
 */
import { db } from "@/db/client";
import {
  userProfileSnapshots,
  rawMessages,
  memoryChunks,
  diaryEntries,
  bodyMetrics,
  todos,
} from "@/db/schema";
import { and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import { callLlm } from "@/lib/llm";
import type Anthropic from "@anthropic-ai/sdk";

const MATERIAL_DAYS = 14;
const RAW_USER_SAMPLE = 50;          // user 発話サンプル件数 (要約用)
const MEMORY_TOP_N = 30;             // owner=user の importance 上位

// ───── 公開 API ─────

export type ProfileSnapshot = {
  id: number;
  snapshotDate: string;              // YYYY-MM-DD (JST)
  personality: string;
  communicationStyle: string;
  currentFocus: string;
  moodTrend: string;
  inferredTraits: string;
  evidenceNotes: string | null;
  inferredImagePrompt: string | null;
  sourceMeta: Record<string, unknown> | null;
  generatedAt: string;
  generatedBy: string;
};

function toApi(row: typeof userProfileSnapshots.$inferSelect): ProfileSnapshot {
  return {
    id: Number(row.id),
    snapshotDate: jstYmdOf(row.snapshotDate),
    personality: row.personality,
    communicationStyle: row.communicationStyle,
    currentFocus: row.currentFocus,
    moodTrend: row.moodTrend,
    inferredTraits: row.inferredTraits,
    evidenceNotes: row.evidenceNotes,
    inferredImagePrompt: row.inferredImagePrompt,
    sourceMeta: row.sourceMeta,
    generatedAt: row.generatedAt.toISOString(),
    generatedBy: row.generatedBy,
  };
}

/** 最新の snapshot を取得 (Yui prompt 注入用)。なければ null。 */
export async function loadActiveProfile(): Promise<ProfileSnapshot | null> {
  const rows = await db
    .select()
    .from(userProfileSnapshots)
    .orderBy(desc(userProfileSnapshots.snapshotDate))
    .limit(1);
  if (rows.length === 0) return null;
  return toApi(rows[0]);
}

export async function loadProfileByDate(ymd: string): Promise<ProfileSnapshot | null> {
  const bounds = jstDayBoundsOf(ymd);
  if (!bounds) return null;
  const rows = await db
    .select()
    .from(userProfileSnapshots)
    .where(
      and(
        gte(userProfileSnapshots.snapshotDate, bounds.start),
        lt(userProfileSnapshots.snapshotDate, bounds.end)
      )
    )
    .limit(1);
  if (rows.length === 0) return null;
  return toApi(rows[0]);
}

export async function loadRecentProfiles(limit = 14): Promise<ProfileSnapshot[]> {
  const rows = await db
    .select()
    .from(userProfileSnapshots)
    .orderBy(desc(userProfileSnapshots.snapshotDate))
    .limit(Math.min(Math.max(limit, 1), 365));
  return rows.map(toApi);
}

/**
 * 指定日の snapshot を生成 (upsert)。
 * generatedBy: "cron" | "manual" | "regen"
 */
export async function generateProfileSnapshot(
  date: Date,
  generatedBy: "cron" | "manual" | "regen" = "cron"
): Promise<ProfileSnapshot> {
  const materials = await collectProfileMaterials(date, MATERIAL_DAYS);
  const userMsg = formatMaterials(materials);

  const response = await callLlm("profile_synth", {
    system: PROFILE_SYNTH_PROMPT,
    messages: [{ role: "user", content: userMsg }],
    maxTokens: 1500,
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  const parsed = parseJsonLoose(text);
  if (!parsed) {
    throw new Error(`profile_synth: failed to parse JSON. raw=${text.slice(0, 200)}`);
  }

  const snapshotDate = jstDayBoundsOf(jstYmdOf(date));
  if (!snapshotDate) throw new Error("invalid date");
  // snapshot_date は DATE 型なので 00:00 JST にする
  const dateOnly = snapshotDate.start;

  const values = {
    snapshotDate: dateOnly,
    personality: String(parsed.personality ?? "(データ不足)"),
    communicationStyle: String(parsed.communication_style ?? "(データ不足)"),
    currentFocus: String(parsed.current_focus ?? "(データ不足)"),
    moodTrend: String(parsed.mood_trend ?? "(データ不足)"),
    inferredTraits: String(parsed.inferred_traits ?? "(データ不足)"),
    evidenceNotes: typeof parsed.evidence_notes === "string" ? parsed.evidence_notes : null,
    inferredImagePrompt:
      typeof parsed.inferred_image_prompt === "string" ? parsed.inferred_image_prompt : null,
    sourceMeta: materials.meta,
    generatedAt: new Date(),
    generatedBy,
  };

  // upsert by snapshot_date
  const inserted = await db
    .insert(userProfileSnapshots)
    .values(values)
    .onConflictDoUpdate({
      target: userProfileSnapshots.snapshotDate,
      set: values,
    })
    .returning();

  return toApi(inserted[0]);
}

// ───── 素材収集 ─────

type Materials = {
  date: string;
  userSample: Array<{ ts: string; content: string }>;
  topMemory: Array<{ chunkType: string; content: string; importance: number }>;
  recentDiaries: Array<{ ymd: string; bodyExcerpt: string }>;
  moodSeries: Array<{ ymd: string; value: number }>;
  weightSeries: Array<{ ymd: string; value: number }>;
  stepsSeries: Array<{ ymd: string; value: number }>;
  todoStats: { done: number; inProgress: number; backlog: number; topTags: string[] };
  meta: Record<string, unknown>;
};

async function collectProfileMaterials(date: Date, daysBack: number): Promise<Materials> {
  const todayYmd = jstYmdOf(date);
  const todayBounds = jstDayBoundsOf(todayYmd);
  if (!todayBounds) throw new Error("invalid date");
  const since = new Date(todayBounds.end.getTime() - daysBack * 24 * 60 * 60 * 1000);

  // 1) user 発話サンプル (直近 N 件 user role のみ、cron 由来除外)
  const rawRows = await db
    .select({ content: rawMessages.content, createdAt: rawMessages.createdAt, source: rawMessages.source })
    .from(rawMessages)
    .where(
      and(
        eq(rawMessages.role, "user"),
        gte(rawMessages.createdAt, since),
        lt(rawMessages.createdAt, todayBounds.end)
      )
    )
    .orderBy(desc(rawMessages.createdAt))
    .limit(RAW_USER_SAMPLE);
  const userSample = rawRows
    .filter((r) => r.source !== "cron")
    .map((r) => ({
      ts: r.createdAt.toISOString(),
      content: r.content.slice(0, 280),
    }));

  // 2) memory_chunks (owner=user、有効、importance 上位)
  const memRows = await db
    .select({
      chunkType: memoryChunks.chunkType,
      content: memoryChunks.content,
      importance: memoryChunks.importance,
    })
    .from(memoryChunks)
    .where(
      and(
        eq(memoryChunks.owner, "user"),
        isNull(memoryChunks.invalidatedAt)
      )
    )
    .orderBy(desc(memoryChunks.importance))
    .limit(MEMORY_TOP_N);

  // 3) 直近 7 日の日記抜粋 (= 「最近何があったか」の素材)
  const diaryRows = await db
    .select({ entryDate: diaryEntries.entryDate, body: diaryEntries.body })
    .from(diaryEntries)
    .where(
      and(
        gte(diaryEntries.entryDate, new Date(todayBounds.end.getTime() - 7 * 24 * 60 * 60 * 1000)),
        lt(diaryEntries.entryDate, todayBounds.end)
      )
    )
    .orderBy(desc(diaryEntries.entryDate))
    .limit(7);
  const recentDiaries = diaryRows.map((d) => ({
    ymd: jstYmdOf(d.entryDate),
    bodyExcerpt: d.body.slice(0, 300),
  }));

  // 4) body_metrics (mood / weight / steps を直近 14 日)
  const metricRows = await db
    .select({
      metricType: bodyMetrics.metricType,
      value: bodyMetrics.value,
      recordedAt: bodyMetrics.recordedAt,
    })
    .from(bodyMetrics)
    .where(
      and(
        gte(bodyMetrics.recordedAt, since),
        lt(bodyMetrics.recordedAt, todayBounds.end)
      )
    )
    .orderBy(desc(bodyMetrics.recordedAt));
  const moodSeries: Array<{ ymd: string; value: number }> = [];
  const weightSeries: Array<{ ymd: string; value: number }> = [];
  const stepsSeries: Array<{ ymd: string; value: number }> = [];
  const seenMood = new Set<string>(), seenWeight = new Set<string>(), seenSteps = new Set<string>();
  for (const m of metricRows) {
    const ymd = jstYmdOf(m.recordedAt);
    if (m.metricType === "mood_1to5" && !seenMood.has(ymd)) {
      seenMood.add(ymd);
      moodSeries.unshift({ ymd, value: m.value });
    } else if (m.metricType === "weight_kg" && !seenWeight.has(ymd)) {
      seenWeight.add(ymd);
      weightSeries.unshift({ ymd, value: m.value });
    } else if (m.metricType === "steps_daily" && !seenSteps.has(ymd)) {
      seenSteps.add(ymd);
      stepsSeries.unshift({ ymd, value: m.value });
    }
  }

  // 5) todo 統計 + 上位 tag
  const todoRowsAll = await db
    .select({
      state: todos.state,
      tags: todos.tags,
      completedAt: todos.completedAt,
    })
    .from(todos);
  let done = 0, inProgress = 0, backlog = 0;
  const tagCount: Record<string, number> = {};
  for (const t of todoRowsAll) {
    // 直近 14 日 done のみ集計、in_progress/backlog は現状件数
    if (t.state === "done") {
      if (t.completedAt && t.completedAt >= since) {
        done++;
        const tagList = Array.isArray(t.tags) ? (t.tags as string[]) : [];
        for (const tag of tagList) tagCount[tag] = (tagCount[tag] ?? 0) + 1;
      }
    } else if (t.state === "in_progress") {
      inProgress++;
    } else if (t.state === "backlog") {
      backlog++;
    }
  }
  const topTags = Object.entries(tagCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([k]) => k);

  return {
    date: todayYmd,
    userSample,
    topMemory: memRows.map((m) => ({
      chunkType: m.chunkType,
      content: m.content,
      importance: m.importance,
    })),
    recentDiaries,
    moodSeries,
    weightSeries,
    stepsSeries,
    todoStats: { done, inProgress, backlog, topTags },
    meta: {
      days_back: daysBack,
      raw_user_sample_count: userSample.length,
      memory_top_count: memRows.length,
      diary_count: recentDiaries.length,
      mood_count: moodSeries.length,
      weight_count: weightSeries.length,
      steps_count: stepsSeries.length,
      todo_done_in_range: done,
    },
  };
}

function formatMaterials(m: Materials): string {
  const lines: string[] = [];
  lines.push(`## 対象日 (JST)`);
  lines.push(m.date);
  lines.push("");

  lines.push(`## 直近 user 発話サンプル (${m.userSample.length} 件、新→古)`);
  if (m.userSample.length === 0) lines.push("(なし)");
  else {
    for (const s of m.userSample.slice(0, 30)) {
      lines.push(`- [${s.ts}] ${s.content}`);
    }
  }
  lines.push("");

  lines.push(`## 高重要度の記憶 (memory_chunks owner=user 上位 ${m.topMemory.length} 件)`);
  if (m.topMemory.length === 0) lines.push("(なし)");
  else {
    for (const c of m.topMemory) {
      lines.push(`- [${c.chunkType} imp=${c.importance.toFixed(2)}] ${c.content}`);
    }
  }
  lines.push("");

  lines.push(`## 直近の日記 (${m.recentDiaries.length} 件、結衣視点の参考)`);
  if (m.recentDiaries.length === 0) lines.push("(なし)");
  else {
    for (const d of m.recentDiaries) {
      lines.push(`- [${d.ymd}] ${d.bodyExcerpt}`);
    }
  }
  lines.push("");

  lines.push(`## 気分推移 (mood_1to5、古→新)`);
  if (m.moodSeries.length === 0) lines.push("(なし)");
  else lines.push(m.moodSeries.map((p) => `${p.ymd}=${p.value}`).join(", "));
  lines.push("");

  lines.push(`## 体重推移 (kg、古→新)`);
  if (m.weightSeries.length === 0) lines.push("(なし)");
  else lines.push(m.weightSeries.map((p) => `${p.ymd}=${p.value.toFixed(1)}`).join(", "));
  lines.push("");

  lines.push(`## 歩数推移 (歩、古→新)`);
  if (m.stepsSeries.length === 0) lines.push("(なし)");
  else lines.push(m.stepsSeries.map((p) => `${p.ymd}=${Math.round(p.value)}`).join(", "));
  lines.push("");

  lines.push(`## TODO 統計`);
  lines.push(`- 直近 ${MATERIAL_DAYS} 日で完了: ${m.todoStats.done} 件`);
  lines.push(`- 現在進行中: ${m.todoStats.inProgress} 件`);
  lines.push(`- backlog: ${m.todoStats.backlog} 件`);
  lines.push(`- 上位 tag: ${m.todoStats.topTags.length > 0 ? m.todoStats.topTags.join(", ") : "(なし)"}`);
  lines.push("");

  lines.push(`上記データから、5 観点 + 根拠 + 画像プロンプトを JSON 1 行で返してください。`);
  return lines.join("\n");
}

// ───── prompts ─────

const PROFILE_SYNTH_PROMPT = `あなたはユーザー (= ご主人様) に関する直近 2 週間のデータを与えられます。
データから観測される事実と、そこから導かれる推測を分けて、簡潔にまとめてください。

【スタイル制約】
- 3 人称で書く ("ご主人様は…")。結衣口調 ("ふふっ" "ですもの" 等) は絶対に使わない
- 感情・愛着・主観の総括は一切入れない (= それは別レコードである日記の役割)
- 推測には根拠を一言添える ("発話の N % が依頼形 → 仕事中心" のように)
- 数値があるものは数値で書く (mood 平均、歩数、active kcal、todo 完了数 等)
- 不明な観点は「データ不足」と書く (= でっち上げない)
- 各フィールドは 80-200 文字程度。長くしすぎない

【5 フィールド】
- personality          : 観測される行動パターンから推論される性格特性
- communication_style  : 話法統計 (口数、論理 / 感情比率、語彙傾向、依頼形比率)
- current_focus        : 直近の関心領域 (active project、高頻度話題、完了 todo の系統)
- mood_trend           : mood_1to5 推移 + 体調 + 行動量 を組み合わせた傾向
- inferred_traits      : 上記から推論される追加特性 (根拠と一緒に書く)

【evidence_notes】
各フィールドの根拠サマリを 2-4 行で添える。

【inferred_image_prompt】
ご主人様の今の状態 / 性質を visual に表すならどんな絵か、英語の image generation
prompt として 1-2 文。

【出力フォーマット】
JSON 1 行のみ、コードフェンスや装飾は不要:

{
  "personality": "...",
  "communication_style": "...",
  "current_focus": "...",
  "mood_trend": "...",
  "inferred_traits": "...",
  "evidence_notes": "...",
  "inferred_image_prompt": "..."
}`;

// ───── helpers ─────

function jstYmdOf(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return `${g("year")}-${g("month")}-${g("day")}`;
}

function jstDayBoundsOf(ymd: string): { start: Date; end: Date } | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) return null;
  const start = new Date(`${ymd}T00:00:00+09:00`);
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

function parseJsonLoose(text: string): Record<string, unknown> | null {
  const cleaned = text
    .replace(/^```(?:json)?\s*\n/, "")
    .replace(/\n```\s*$/, "")
    .trim();
  const m = cleaned.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// 未使用警告抑止 (sql 等を将来使うため)
void sql;
