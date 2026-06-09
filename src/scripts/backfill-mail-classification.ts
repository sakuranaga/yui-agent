/**
 * 既存メール全件への bucket バックフィル。
 *
 * 設計: docs/mail-classification.md §10.2
 *
 * Usage (host shell):
 *   docker compose exec web npx tsx src/scripts/backfill-mail-classification.ts [--limit=N] [--batch=N]
 *
 * 100 通/バッチで curateMails() を呼ぶ。per-mail 3-5 秒想定 → 15k 件で半日 〜 一晩。
 * 中断されても classified_at IS NULL の残りだけが対象になるので再開可能。
 */
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
import { isNull, asc } from "drizzle-orm";
import { curateMails } from "@/lib/mail-curate";

async function main() {
  const args = process.argv.slice(2);
  let limit = Infinity;
  let batchSize = 100;
  for (const a of args) {
    const [k, v] = a.replace(/^--/, "").split("=");
    if (k === "limit") limit = parseInt(v, 10);
    if (k === "batch") batchSize = parseInt(v, 10);
  }

  let total = 0;
  let batchNo = 0;

  while (total < limit) {
    const remaining = Math.min(batchSize, limit - total);
    const rows = await db
      .select({ id: mailMessages.id })
      .from(mailMessages)
      .where(isNull(mailMessages.classifiedAt))
      .orderBy(asc(mailMessages.receivedAt))
      .limit(remaining);

    if (rows.length === 0) break;
    batchNo++;
    const ids = rows.map((r) => r.id);
    console.log(`[backfill] batch ${batchNo}: ${ids.length} mails (total processed=${total})`);
    const t0 = Date.now();
    await curateMails(ids);
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`[backfill] batch ${batchNo} done in ${dt}s`);
    total += rows.length;
  }

  console.log(`[backfill] all done — ${total} mails classified across ${batchNo} batch(es)`);
  process.exit(0);
}

main().catch((e) => {
  console.error("[backfill] fatal:", e);
  process.exit(1);
});
