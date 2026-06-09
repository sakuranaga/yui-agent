/**
 * 朝のブリーフィング DB アクセス層。
 *
 * - saveMorningBrief: 当日分を UPSERT (同日 2 度発火しても 1 行)
 * - getMorningBriefForDate: 指定日 (YYYY-MM-DD) の brief 1 件
 * - getLatestMorningBrief: 最新 1 件
 * - listMorningBriefs: 新しい順 N 件
 */
import { db } from "@/db/client";
import { morningBriefs, type MorningBrief } from "@/db/schema";
import { desc, eq, sql } from "drizzle-orm";

export async function saveMorningBrief(opts: {
  dateYmd: string;
  markdown: string;
  sourceMeta?: Record<string, unknown>;
}): Promise<{ id: number } | null> {
  // entry_date は DATE 型なので YYYY-MM-DD 文字列を ::date キャスト。
  // start.toISOString() 経由だと UTC 換算で前日にズレうるので避ける (diary 同様)。
  const result = await db.execute<{ id: number }>(sql`
    INSERT INTO morning_briefs (entry_date, markdown, source_meta)
    VALUES (
      ${opts.dateYmd}::date,
      ${opts.markdown},
      ${opts.sourceMeta ? JSON.stringify(opts.sourceMeta) : null}::jsonb
    )
    ON CONFLICT (entry_date) DO UPDATE
      SET markdown = EXCLUDED.markdown,
          source_meta = EXCLUDED.source_meta,
          generated_at = NOW()
    RETURNING id
  `);
  // drizzle-postgres-js: result は rows っぽい配列 (.rows プロパティ or 直接)
  const rows = (result as unknown as { rows?: { id: number }[] }).rows ?? (result as unknown as { id: number }[]);
  const row = Array.isArray(rows) ? rows[0] : undefined;
  return row ? { id: Number(row.id) } : null;
}

export async function getMorningBriefForDate(dateYmd: string): Promise<MorningBrief | null> {
  const [row] = await db
    .select()
    .from(morningBriefs)
    .where(sql`${morningBriefs.entryDate} = ${dateYmd}::date`)
    .limit(1);
  return row ?? null;
}

export async function getLatestMorningBrief(): Promise<MorningBrief | null> {
  const [row] = await db
    .select()
    .from(morningBriefs)
    .orderBy(desc(morningBriefs.entryDate))
    .limit(1);
  return row ?? null;
}

export async function listMorningBriefs(limit = 14): Promise<MorningBrief[]> {
  return db
    .select()
    .from(morningBriefs)
    .orderBy(desc(morningBriefs.entryDate))
    .limit(limit);
}

/** entry_date を YYYY-MM-DD 文字列で取り出すヘルパ。
 * schema 上は `timestamp({ mode: "date" })` で Date 確定なので、その前提で format する。 */
export function briefDateYmd(b: MorningBrief): string {
  const d = b.entryDate;
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// drizzle-orm の eq を re-export しないが、importer のため型エクスポート
export type { MorningBrief };
export { eq };
