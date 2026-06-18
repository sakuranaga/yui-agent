/**
 * ツール重複実行ガード (docs/tool-dedup-and-adding-tools.md)。
 *
 * mutation/外部送信を runTool 共通層で記録し、会話ターンをまたぐ重複 (過去依頼の再実行・
 * 文字違いの同一予定) を防ぐ。判定: 同 scope+tool+anchor を時間窓で粗絞り → title embedding 類似で精査。
 * reservation + status (executing/pending_confirmation/executed) + advisory lock で race と確認待ち重複を防ぐ。
 */
import { db } from "@/db/client";
import { sql, eq } from "drizzle-orm";
import { toolExecutionLog } from "@/db/schema";
import { embed, toPgVector } from "@/lib/embed";
import { getEmbedConfig } from "@/lib/ai-settings";
import type { ToolDef, ToolContext } from "@/lib/tools/types";

const NULL_ANCHOR = "__null__";
export const DEDUP_SKIP_REASON = "dedup_recent_execution";

/** 日時文字列を anchor キーに正規化。
 *  - 終日 (YYYY-MM-DD) → そのまま
 *  - dateTime (TZ 付き含む) → UTC 分単位 (TZ 違いの同一時刻を同じキーに) */
export function normalizeAnchorDateTime(dt: string | null | undefined): string | null {
  if (!dt || typeof dt !== "string") return null;
  const s = dt.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s; // 終日
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm (UTC)
}

export type DedupReserveResult =
  | { duplicate: true }
  | { duplicate: false; reservationId: number };

/** dedup 対象ツールの実行前チェック + reservation。重複なら skipped 行を残して { duplicate: true }。
 *  status="executing" (auto) | "pending_confirmation" (confirm)。 */
export async function dedupCheckAndReserve(
  tool: ToolDef,
  input: unknown,
  ctx: ToolContext,
  status: "executing" | "pending_confirmation",
): Promise<DedupReserveResult | null> {
  const dd = tool.dedup;
  if (!dd) return null; // ガード対象外

  // dedup インフラ障害 (config/anchor 計算/embed/vector/DB いずれか) は fail-open で実行を止めない。
  // 重複の取りこぼしより、正規の操作をブロックする方が害が大きい
  // (二重登録はユーザーが消せるが、未実行は気づきにくい)。embed 単体失敗は anchor/lexical へ縮退。
  try {
    const scope = dd.scope(input, ctx);
    const anchor = dd.anchor(input) ?? NULL_ANCHOR;
    const title = (dd.title(input) ?? "").trim() || tool.name;
    const threshold = dd.threshold ?? 0.85;
    const windowMin = dd.windowMinutes ?? 10;

    // embedding は txn の外で計算 (DB lock を embed ネットワーク待ちで握らない)。
    const cfg = await getEmbedConfig();
    let emb: number[] | null = null;
    try {
      emb = (await embed(title)) as number[];
    } catch (e) {
      console.warn("[dedup] embed 失敗 → anchor/lexical のみで判定:", e);
    }
    const vec = emb ? toPgVector(emb) : null;
    const lockKey = `${scope}|${tool.name}|${anchor}`;
    const toolName = tool.name;

    return await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

      // 衝突判定: 同 scope+tool+anchor、窓内、status in (executing|pending_confirmation|executed)。
      const winSql = sql`now() - (${windowMin} * interval '1 minute')`;
      let isDup = false;
      if (vec) {
        // embedding あり → embedding_model 一致 + cosine >= 閾値 (文字違いの同一意図を拾う)。
        const rows = (await tx.execute(sql`
          SELECT id FROM tool_execution_log
          WHERE scope_key = ${scope} AND tool_name = ${toolName} AND dedup_anchor = ${anchor}
            AND status IN ('executing','pending_confirmation','executed')
            AND created_at > ${winSql}
            AND embedding_model = ${cfg.model} AND title_embedding IS NOT NULL
            AND (1 - (title_embedding <=> ${vec}::vector)) >= ${threshold}
          LIMIT 1`)) as unknown[];
        isDup = rows.length > 0;
      } else if (anchor !== NULL_ANCHOR) {
        // embedding 失敗時は anchor 一致だけで弾くと同時刻の別予定を誤検知する。
        // anchor 一致 + 正規化 title の lexical 完全一致の時のみ重複とみなす (A6 lexical 補助)。
        const rows = (await tx.execute(sql`
          SELECT title_text FROM tool_execution_log
          WHERE scope_key = ${scope} AND tool_name = ${toolName} AND dedup_anchor = ${anchor}
            AND status IN ('executing','pending_confirmation','executed')
            AND created_at > ${winSql}`)) as Array<{ title_text: string }>;
        const norm = normalizeTitle(title);
        isDup = rows.some((r) => normalizeTitle(r.title_text) === norm);
      }
      // anchor == __null__ かつ embedding 失敗 → 判定不能なので衝突なし (二重実行を許す安全側)。

      if (isDup) {
        // 監査用に skipped 行を残す (衝突対象には含めない status)。
        await tx.insert(toolExecutionLog).values({
          scopeKey: scope, toolName, dedupAnchor: anchor, titleText: title,
          titleEmbedding: emb ?? undefined, embeddingModel: emb ? cfg.model : undefined,
          embeddingDimensions: emb ? cfg.dimensions : undefined,
          status: "skipped", args: asRecord(input),
        });
        return { duplicate: true } as const;
      }

      const [row] = await tx
        .insert(toolExecutionLog)
        .values({
          scopeKey: scope, toolName, dedupAnchor: anchor, titleText: title,
          titleEmbedding: emb ?? undefined, embeddingModel: emb ? cfg.model : undefined,
          embeddingDimensions: emb ? cfg.dimensions : undefined,
          status, args: asRecord(input),
        })
        .returning({ id: toolExecutionLog.id });
      return { duplicate: false, reservationId: row.id } as const;
    });
  } catch (e) {
    console.warn("[dedup] check/reserve 失敗 → ガード無しで続行 (fail-open):", e);
    return null;
  }
}

/** lexical 比較用にタイトルを正規化 (空白除去 + lowercase)。 */
function normalizeTitle(s: string): string {
  return (s ?? "").replace(/\s+/g, "").toLowerCase();
}

// finalize 系は best-effort (監査ステータス更新)。失敗しても tool フローは止めない。
// 取りこぼした executing/pending_confirmation は periodic cleanup が backstop で落とす。

/** reservation を確定 (auto: 実行後)。 */
export async function finalizeReservation(
  reservationId: number,
  status: "executed" | "failed",
): Promise<void> {
  if (reservationId < 0) return;
  try {
    await db
      .update(toolExecutionLog)
      .set({ status, updatedAt: new Date() })
      .where(eq(toolExecutionLog.id, reservationId));
  } catch (e) {
    console.warn(`[dedup] finalizeReservation(${reservationId}, ${status}) 失敗:`, e);
  }
}

/** confirm reservation に確認 token を紐付ける (runTool が requestUserConfirm 後に呼ぶ)。 */
export async function setReservationConfirmToken(reservationId: number, token: string): Promise<void> {
  if (reservationId < 0) return;
  try {
    await db
      .update(toolExecutionLog)
      .set({ confirmToken: token, updatedAt: new Date() })
      .where(eq(toolExecutionLog.id, reservationId));
  } catch (e) {
    console.warn(`[dedup] setReservationConfirmToken(${reservationId}) 失敗:`, e);
  }
}

/** confirm_token で reservation を確定 (executePendingTool が承認実行後/拒否時に呼ぶ)。 */
export async function finalizeReservationByToken(
  token: string,
  status: "executed" | "failed" | "cancelled",
): Promise<void> {
  try {
    await db
      .update(toolExecutionLog)
      .set({ status, updatedAt: new Date() })
      .where(eq(toolExecutionLog.confirmToken, token));
  } catch (e) {
    console.warn(`[dedup] finalizeReservationByToken(${status}) 失敗:`, e);
  }
}

function asRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}
