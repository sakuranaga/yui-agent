/**
 * food_logs.nutrition_status = 'pending' の行を pickup し、
 * lookupNutrition (= 既存 web 検索 + LLM 抽出経路) で kcal/PFC を fill する worker。
 *
 * 設計:
 *   - extractor (food-extract.ts) が pending 行を INSERT 直後に kickFillWorker() を呼ぶ
 *   - in-memory mutex で多重起動防止 (= 同時に 1 worker のみ走る)
 *   - 1 起動で「現時点で pending な全行」を順次処理
 *   - 1 アイテム成功 → 行の totals + items[].kcal/PFC を update → status='done'
 *   - 全 lookup 失敗 → status='failed' (= UI で「不明」表示)
 *   - 部分成功 (一部 item 不明) → status='done' のまま、未取得 item は kcal=null
 *
 * private モード会話で extract がそもそも走らないので、worker も自動的に巻き込まない。
 */
import { db } from "@/db/client";
import { foodLogs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { lookupNutrition } from "@/lib/food-nutrition";
import { mapPool } from "@/lib/async-pool";

let running = false;
let pendingRetrigger = false;

/**
 * 起動時の crash recovery: 前回 run 中に「processing」のまま落ちた行を pending に戻す。
 * 通常実行中に呼ぶと in-flight な行を pending に戻して二重処理になるので **startup のみ** で呼ぶこと。
 */
export async function releaseStuckProcessing(): Promise<number> {
  const result = await db
    .update(foodLogs)
    .set({ nutritionStatus: "pending" })
    .where(eq(foodLogs.nutritionStatus, "processing"))
    .returning({ id: foodLogs.id });
  if (result.length > 0) {
    console.log(`[food-nutrition-worker] released ${result.length} stuck 'processing' row(s) back to 'pending'`);
  }
  return result.length;
}

export async function kickFillWorker(): Promise<void> {
  if (running) {
    // 既に走ってる間に追加 INSERT が来た場合、現 run が終わってからもう 1 周回す
    pendingRetrigger = true;
    return;
  }
  running = true;
  try {
    do {
      pendingRetrigger = false;
      await processAllPending();
    } while (pendingRetrigger);
  } finally {
    running = false;
  }
}

async function processAllPending(): Promise<void> {
  // 行リース: pending → processing に UPDATE...RETURNING で atomic に取得。
  // 同 process 内 race は in-memory mutex (running flag) で防いでるが、worker が
  // 別プロセスで動く未来 / 再起動跨ぎで重複 lookup されないよう DB レベルでも claim。
  // processing 状態の行は別 tick が拾わない。完了後 'done'/'partial'/'failed' に遷移する。
  const claimedRows = await db.execute<{ id: number; items: unknown }>(
    (await import("drizzle-orm")).sql`
      UPDATE food_logs
      SET nutrition_status = 'processing'
      WHERE id IN (
        SELECT id FROM food_logs
        WHERE nutrition_status = 'pending'
        ORDER BY created_at
        LIMIT 50
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id, items
    `
  );
  const rows = (claimedRows as unknown as { rows?: Array<{ id: number; items: unknown }> }).rows
    ?? (claimedRows as unknown as Array<{ id: number; items: unknown }>);
  if (!rows || rows.length === 0) return;
  console.log(`[food-nutrition-worker] claimed ${rows.length} pending row(s)`);

  for (const row of rows) {
    await fillOne(Number(row.id), row.items as Array<{
      name: string;
      quantity?: number;
      unit?: string;
      kcal?: number | null;
      protein?: number | null;
      carbs?: number | null;
      fat?: number | null;
      fiber?: number | null;
    }>);
  }
}

async function fillOne(
  id: number,
  items: Array<{
    name: string;
    quantity?: number;
    unit?: string;
    kcal?: number | null;
    protein?: number | null;
    carbs?: number | null;
    fat?: number | null;
    fiber?: number | null;
    salt?: number | null;
  }>
): Promise<void> {
  let totalKcal = 0, totalP = 0, totalC = 0, totalF = 0, totalFiber = 0, totalSalt = 0;
  let anyKnown = false;
  let allKnown = true;

  // lookupNutrition は外部 nutrition DB / web 検索 + LLM を含むため item ごとに数秒。
  // 旧実装は完全直列で 5 項目 = 15-30 秒。並列度 3 のプールで wall-clock を 1/3 に。
  // (順序は items の入力順を維持するので enriched は元の並びどおり)
  const lookups = await mapPool(items, 3, async (it) => {
    try {
      return await lookupNutrition(it.name);
    } catch (e) {
      console.warn(`[food-nutrition-worker] lookup failed for ${it.name}:`, e instanceof Error ? e.message : e);
      return null;
    }
  });

  const enriched: typeof items = items.map((it, i) => {
    const qty = typeof it.quantity === "number" && it.quantity > 0 ? it.quantity : 1;
    const unit = it.unit ?? "";
    const nut = lookups[i];
    if (!nut) {
      allKnown = false;
      return { ...it, quantity: qty, unit, kcal: null, protein: null, carbs: null, fat: null, fiber: null, salt: null };
    }
    anyKnown = true;
    const kcal = nut.kcalPerUnit * qty;
    const p = (nut.protein ?? 0) * qty;
    const c = (nut.carbs ?? 0) * qty;
    const f = (nut.fat ?? 0) * qty;
    const fib = (nut.fiber ?? 0) * qty;
    const salt = (nut.salt ?? 0) * qty;
    totalKcal += kcal;
    totalP += p;
    totalC += c;
    totalF += f;
    totalFiber += fib;
    totalSalt += salt;
    return {
      name: it.name,
      quantity: qty,
      unit: unit || nut.unit,
      kcal, protein: p, carbs: c, fat: f, fiber: fib, salt,
    };
  });

  // 全 item 失敗 → failed、全 item 成功 → done、部分成功 → partial。
  // partial では total* を NULL にして「黙った過少計上」を防ぐ (= 旧コードは部分成功でも
  // sub-total を書いて status=done にしていたので、日次 kcal が静かに under-count されていた)。
  // API 集計側は totalKcal === null を hasUnknown 扱いするので、partial は自動的に
  // 「不明品含む」表示になる。
  const nextStatus = !anyKnown ? "failed" : (allKnown ? "done" : "partial");
  const persistTotals = allKnown; // partial / failed は null
  await db
    .update(foodLogs)
    .set({
      items: enriched,
      totalKcal: persistTotals ? totalKcal : null,
      totalProtein: persistTotals ? totalP : null,
      totalCarbs: persistTotals ? totalC : null,
      totalFat: persistTotals ? totalF : null,
      totalFiber: persistTotals ? totalFiber : null,
      totalSalt: persistTotals ? totalSalt : null,
      nutritionStatus: nextStatus,
    })
    .where(eq(foodLogs.id, id));
  console.log(
    `[food-nutrition-worker] id=${id} → ${nextStatus} (~${Math.round(totalKcal)} kcal, salt=${totalSalt.toFixed(1)}g, allKnown=${allKnown})`
  );
}
