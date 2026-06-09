/**
 * PATCH  /api/food/<id>     items 編集 (kcal / quantity / unit / name など)
 * DELETE /api/food/<id>     ログ削除
 *
 * PATCH の動作:
 *   - body: { items: [...] }
 *     items は新しい全配列。各 item の kcal は per-unit ではなく item line 合計
 *     (= per_unit * quantity)。総計は recompute される。
 *   - food_reference cache に「per-unit 値が変わった item」を書き戻し:
 *       新 per_unit = new kcal / quantity
 *     これにより同じ食材を次回食べた時、訂正後の値で記録される。
 *   - quantity が変わっただけ → cache 書き戻し無し (元の per_unit が正しいので)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import { foodLogs, foodReference } from "@/db/schema";
import { eq } from "drizzle-orm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

type EditableItem = {
  name: string;
  quantity?: number;
  unit?: string;
  kcal?: number | null;
  protein?: number | null;
  carbs?: number | null;
  fat?: number | null;
  fiber?: number | null;
  salt?: number | null;
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = parseInt(id, 10);
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as { items?: EditableItem[]; notes?: string | null };
    const [existing] = await db.select().from(foodLogs).where(eq(foodLogs.id, idNum)).limit(1);
    if (!existing) return NextResponse.json({ error: "not found" }, { status: 404 });

    const oldItems = (existing.items as EditableItem[]) ?? [];
    const newItems = Array.isArray(body.items) ? body.items : oldItems;

    // 集計再計算 (kcal が null の item があれば allKnown=false → 集計列も null)
    let totalKcal = 0, totalP = 0, totalC = 0, totalF = 0, totalFiber = 0, totalSalt = 0;
    let allKnown = true;
    for (const it of newItems) {
      if (typeof it.kcal !== "number" || !Number.isFinite(it.kcal)) {
        allKnown = false;
        continue;
      }
      totalKcal += it.kcal;
      totalP += it.protein ?? 0;
      totalC += it.carbs ?? 0;
      totalF += it.fat ?? 0;
      totalFiber += it.fiber ?? 0;
      totalSalt += it.salt ?? 0;
    }

    // food_reference cache 書き戻し: kcal が「以前と変わった」item の per-unit 値を更新。
    //
    // 旧実装は oldItems[i] vs newItems[i] と「配列位置」で比較していたが、user が
    // 並び替え/追加/削除した時に index が ずれて、別 item の kcal を比較して誤検知
    // (= 全然違う food の cache を上書きする) や取り逃しが起きていた。
    // 正しい対応相手は「同じ食材」= normalize(name) が一致する old item なので、
    // 先に normalizedName → oldItem の Map を作って lookup に切り替える。
    //
    // 同名重複の扱い: 1 つの食事ログ内に同じ normalizedName が複数ある場合
    // (例: "卵" を 2 行に分けて記録) は、どちらの old が new と対応するか不確定。
    // last-write-wins で 1 つ採用すると曖昧な per-unit を food_reference に永続化
    // してしまうため、count を取って 2+ ある normalizedName は writeback skip する。
    // 実際の集計 (totalKcal 等) は newItems から再計算しているので影響なし。
    const oldByName = new Map<string, EditableItem>();
    const oldNameCount = new Map<string, number>();
    for (const oi of oldItems) {
      const norm = normalize(oi.name);
      if (norm.length === 0) continue;
      oldByName.set(norm, oi);
      oldNameCount.set(norm, (oldNameCount.get(norm) ?? 0) + 1);
    }
    for (const ni of newItems) {
      if (typeof ni.kcal !== "number") continue;
      const norm = normalize(ni.name);
      if (norm.length === 0) continue;
      // 旧 items に同名が複数あった場合は writeback 対象が一意に定まらないので skip
      if ((oldNameCount.get(norm) ?? 0) > 1) continue;
      const oi = oldByName.get(norm);
      if (!oi || typeof oi.kcal !== "number") continue;
      if (ni.kcal === oi.kcal) continue;
      // quantity が変わってない & kcal だけ変わった → per-unit を新値に更新
      const qty = ni.quantity ?? 1;
      // ゼロ / 不正 quantity でゼロ除算 → Infinity が food_reference キャッシュに永続化
      // するので skip。?? 演算子は 0 を捕捉しないので明示チェック必要。
      if (!Number.isFinite(qty) || qty <= 0) continue;
      if ((ni.quantity ?? 1) !== (oi.quantity ?? 1)) continue;
      const newPerUnit = ni.kcal / qty;
      try {
        await db
          .update(foodReference)
          .set({
            kcalPerUnit: newPerUnit,
            protein: ni.protein !== null && ni.protein !== undefined ? ni.protein / qty : null,
            carbs: ni.carbs !== null && ni.carbs !== undefined ? ni.carbs / qty : null,
            fat: ni.fat !== null && ni.fat !== undefined ? ni.fat / qty : null,
            fiber: ni.fiber !== null && ni.fiber !== undefined ? ni.fiber / qty : null,
            salt: ni.salt !== null && ni.salt !== undefined ? ni.salt / qty : null,
            confidence: "high",
            lookedUpAt: new Date(),
          })
          .where(eq(foodReference.normalizedName, norm));
      } catch (e) {
        console.warn("[food/[id]] food_reference writeback failed:", e);
      }
    }

    await db
      .update(foodLogs)
      .set({
        items: newItems,
        totalKcal: allKnown ? totalKcal : null,
        totalProtein: allKnown ? totalP : null,
        totalCarbs: allKnown ? totalC : null,
        totalFat: allKnown ? totalF : null,
        totalFiber: allKnown ? totalFiber : null,
        totalSalt: allKnown ? totalSalt : null,
        notes: body.notes ?? existing.notes,
      })
      .where(eq(foodLogs.id, idNum));

    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "food/[id]", message: "食事ログの更新に失敗しました" });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const idNum = parseInt(id, 10);
  if (!Number.isFinite(idNum)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  await db.delete(foodLogs).where(eq(foodLogs.id, idNum));
  return NextResponse.json({ ok: true });
}

function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[!-/:-@\[-`{-~]/g, "")
    .trim();
}
