/**
 * 並行ジョブの atomic claim helper。
 *
 * 「今日 1 回だけ実行する」「同 day で重複 INSERT したくない」系のジョブで使う。
 * INSERT ON CONFLICT DO NOTHING で取り合い、戻り行があれば claim 成功 = 自分が本処理する。
 * 戻り行が無ければ他 tick が先に取った = 自分は skip する。
 *
 * 使い方:
 *   const claimed = await claimJob({ key: `memory-decay:${ymdJst}`, moduleId: "memory-decay" });
 *   if (!claimed) return { skip: true, reason: "claimed by overlap tick" };
 *   // ... 本処理 ...
 */
import { db } from "@/db/client";
import { jobClaims } from "@/db/schema";
import { lt } from "drizzle-orm";

export type ClaimOpts = {
  /** ユニークキー (= "module-id:ymd_jst" 等。同じ key で 2 回目は claim 失敗) */
  key: string;
  /** 観測用ラベル (= claim 元のモジュール ID) */
  moduleId: string;
  /** 追加メタ (= 任意。後で claim 履歴を漁る時に役立つ) */
  meta?: Record<string, unknown>;
};

/**
 * claim を試みる。
 * @returns true = 自分が claim した (= 本処理を実行してよい)
 *          false = 他 tick が先に取った (= 本処理は skip すべき)
 */
export async function claimJob(opts: ClaimOpts): Promise<boolean> {
  const inserted = await db
    .insert(jobClaims)
    .values({
      claimKey: opts.key,
      moduleId: opts.moduleId,
      meta: opts.meta,
    })
    .onConflictDoNothing()
    .returning({ key: jobClaims.claimKey });
  return inserted.length > 0;
}

/**
 * 古い claim 行を一掃 (= cleanup 用、毎週などで呼ぶ想定)。
 * @param keepDays 何日分残すか
 */
export async function pruneOldClaims(keepDays: number = 30): Promise<number> {
  const cutoff = new Date(Date.now() - keepDays * 86_400_000);
  const deleted = await db
    .delete(jobClaims)
    .where(lt(jobClaims.claimedAt, cutoff))
    .returning({ key: jobClaims.claimKey });
  return deleted.length;
}
