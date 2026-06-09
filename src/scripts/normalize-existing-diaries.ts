/**
 * 既存 diary_entries の body_tts を埋める one-shot script。
 *
 * 使い方:
 *   docker compose exec web npx tsx src/scripts/normalize-existing-diaries.ts
 *   docker compose exec web npx tsx src/scripts/normalize-existing-diaries.ts --force
 *   docker compose exec web npx tsx src/scripts/normalize-existing-diaries.ts 2026-05-27 2026-05-28
 *
 * オプション:
 *   --force        既に body_tts が入っている entry も上書きする
 *   YYYY-MM-DD ... 対象日付を引数で限定 (省略時は body_tts が NULL の全件)
 */
import { db } from "@/db/client";
import { sql } from "drizzle-orm";
import { normalizeForTTS } from "@/lib/tts-normalize";

type Row = { id: number; entry_date: string; body: string; body_tts: string | null };

async function main() {
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dates = args.filter((a) => /^\d{4}-\d{2}-\d{2}$/.test(a));

  let rows: Row[];
  if (dates.length > 0) {
    const placeholders = dates.map((d) => `'${d}'::date`).join(",");
    const res = await db.execute<Row>(sql.raw(
      `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, body, body_tts
       FROM diary_entries
       WHERE entry_date IN (${placeholders})
       ORDER BY entry_date DESC`
    ));
    rows = ((res as unknown as { rows?: Row[] }).rows ?? (res as unknown as Row[])) as Row[];
  } else {
    const where = force ? "" : "WHERE body_tts IS NULL";
    const res = await db.execute<Row>(sql.raw(
      `SELECT id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date, body, body_tts
       FROM diary_entries
       ${where}
       ORDER BY entry_date DESC`
    ));
    rows = ((res as unknown as { rows?: Row[] }).rows ?? (res as unknown as Row[])) as Row[];
  }

  if (rows.length === 0) {
    console.log("[normalize-diaries] 対象なし");
    return;
  }

  console.log(`[normalize-diaries] ${rows.length} 件処理開始`);
  let ok = 0;
  let skipped = 0;
  let failed = 0;

  for (const r of rows) {
    if (!force && r.body_tts) {
      skipped++;
      continue;
    }
    process.stdout.write(`[${r.entry_date}] 正規化中… `);
    const t0 = Date.now();
    const normalized = await normalizeForTTS(r.body);
    if (!normalized) {
      console.log(`FAILED (${Date.now() - t0}ms)`);
      failed++;
      continue;
    }
    await db.execute(sql`UPDATE diary_entries SET body_tts = ${normalized} WHERE id = ${r.id}`);
    console.log(`OK ${normalized.length}文字 (${Date.now() - t0}ms)`);
    ok++;
  }

  console.log(`[normalize-diaries] 完了: ok=${ok} skipped=${skipped} failed=${failed}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("[normalize-diaries] failed:", e);
    process.exit(1);
  });
