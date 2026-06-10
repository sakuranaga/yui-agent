/**
 * 英→カタカナ CSV を tts_dictionary に一括取り込み (= source='cmudict')。
 *
 * - CSV (= scripts/gen-katakana-dict.py の出力、ヘッダ "word,reading") を読み、
 *   1000 行ごとに batch insert。`onConflictDoNothing(target: word)` で **既存の
 *   user/preset エントリは絶対に上書きしない** (= 手動キュレート最優先)。
 * - 冪等: 何度流しても既存 word は skip。途中再実行も安全。
 * - `--reset`: 取り込み前に source='cmudict' を全削除 (= 辞書の作り直し用)。
 *
 * Usage (container 内):
 *   npx tsx scripts/tts-dict-import.ts [csv_path] [--reset]
 *   既定 csv_path = ./english_to_katakana_dict.csv
 *
 * 注: web プロセスの in-memory cache (TTL 60 秒) は別プロセスなので即時反映されない。
 *     取り込み後 60 秒以内に TTS 経路が新エントリを拾う (= cross-process invalidation なし)。
 *
 * 注: scripts/** は eslint.config.mjs で lint 対象外 (= 全 dev スクリプト共通)。
 *     tsconfig include 対象なので `npm run typecheck` では型検査される。
 */
import { readFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { db, sql } from "@/db/client";
import { ttsDictionary } from "@/db/schema";

const BATCH = 1000;

type Row = { word: string; reading: string };

/** "word,reading" 行をパース (= fields は a-z' / カタカナで comma を含まない前提、最初の comma で分割)。 */
function parseCsv(text: string): Row[] {
  const out: Row[] = [];
  const seen = new Set<string>();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const comma = line.indexOf(",");
    if (comma < 0) continue;
    const word = line.slice(0, comma).trim();
    const reading = line.slice(comma + 1).trim();
    if (!word || !reading) continue;
    if (i === 0 && word.toLowerCase() === "word") continue; // ヘッダ行
    const key = word.toLowerCase();
    if (seen.has(key)) continue; // CSV 内重複の dedup (= 最小フィルタ)
    seen.add(key);
    out.push({ word, reading });
  }
  return out;
}

async function main() {
  const args = process.argv.slice(2);
  const reset = args.includes("--reset");
  const csvPath = args.find((a) => !a.startsWith("--")) ?? "./english_to_katakana_dict.csv";

  console.log(`[import] reading ${csvPath} ...`);
  const text = await readFile(csvPath, "utf-8");
  const rows = parseCsv(text);
  console.log(`[import] parsed ${rows.length} unique rows`);

  if (reset) {
    const del = await db.delete(ttsDictionary).where(eq(ttsDictionary.source, "cmudict")).returning({ id: ttsDictionary.id });
    console.log(`[import] --reset: deleted ${del.length} existing cmudict rows`);
  }

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH).map((r) => ({
      word: r.word,
      reading: r.reading,
      enabled: true,
      source: "cmudict",
    }));
    const res = await db
      .insert(ttsDictionary)
      .values(batch)
      .onConflictDoNothing({ target: ttsDictionary.word })
      .returning({ id: ttsDictionary.id });
    inserted += res.length;
    if ((i / BATCH) % 10 === 0 || i + BATCH >= rows.length) {
      console.log(
        `[import] ${Math.min(i + BATCH, rows.length)}/${rows.length} processed, ${inserted} newly inserted`
      );
    }
  }

  const [{ total }] = (await sql`
    SELECT count(*)::int AS total FROM tts_dictionary WHERE source = 'cmudict'
  `) as unknown as Array<{ total: number }>;
  console.log(`[import] done. newly inserted ${inserted}, total cmudict rows now ${total}.`);
  console.log(`[import] (web プロセスの TTS cache は最大 60 秒で反映)`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[tts-dict-import] failed:", e);
  process.exit(1);
});
