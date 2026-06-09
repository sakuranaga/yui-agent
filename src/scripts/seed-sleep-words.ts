/**
 * sleep-words.json を読んで sleep_words に bulk insert する。
 * 実行: docker compose exec web npx tsx src/scripts/seed-sleep-words.ts
 *
 * 既存 row との重複は UNIQUE (category_id, word) で弾かれる (ON CONFLICT DO NOTHING)。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db } from "@/db/client";
import { sleepCategories, sleepWords } from "@/db/schema";
import { eq } from "drizzle-orm";

type SeedJson = Record<string, Array<[string, number]>> & { _note?: string };

async function main() {
  const jsonPath = join(process.cwd(), "src/db/seed/sleep-words.json");
  const raw = readFileSync(jsonPath, "utf-8");
  const data = JSON.parse(raw) as SeedJson;

  const categories = await db.select().from(sleepCategories);
  const byName = new Map(categories.map((c) => [c.name, c.id]));

  let totalInserted = 0;
  for (const [name, entries] of Object.entries(data)) {
    if (name.startsWith("_")) continue; // _note 等のメタデータ行をスキップ
    if (!Array.isArray(entries)) continue; // narrowing: entries は配列のみ受け付け
    const catId = byName.get(name);
    if (!catId) {
      console.warn(`[seed] unknown category: ${name}`);
      continue;
    }
    const rows = entries.map(([word, difficulty]: [string, number]) => ({
      categoryId: catId,
      word,
      difficulty: Math.max(1, Math.min(3, Math.floor(difficulty))),
    }));
    if (rows.length === 0) continue;
    const inserted = await db
      .insert(sleepWords)
      .values(rows)
      .onConflictDoNothing({ target: [sleepWords.categoryId, sleepWords.word] })
      .returning({ id: sleepWords.id });
    console.log(
      `[seed] ${name}: ${inserted.length}/${rows.length} inserted (skipped duplicates: ${rows.length - inserted.length})`
    );
    totalInserted += inserted.length;
  }
  void eq;
  console.log(`[seed] total inserted: ${totalInserted}`);
  process.exit(0);
}

void main().catch((e) => {
  console.error(e);
  process.exit(1);
});
