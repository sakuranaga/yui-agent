/**
 * tier 割当の能力ゲート + 参照検出 (#206 M4)。
 *
 * - checkToolSlots: 指定スロット (label/entryId/requiresTool) が tool 非対応 entry を
 *   指していないか検証。route は **この PUT で変更されたスロットだけ**を渡す
 *   (= seed 由来の未テスト entry を grandfather し、無関係な変更を過剰にブロックしない)。
 *   tool 必須スロット同士に横断制約は無い (各 main/heavy スロットが独立に tool 対応必須) ので、
 *   変更スロットのみの検証で判定漏れは出ない。
 * - roleRequiresTool: role の既定 tier が main/heavy か (= entry-id 直指定で tool 必須か)。
 * - findEntryReferences: 削除ガード用に、entry が tier 割当 / fallback / role 上書きに
 *   直接参照されている箇所を列挙。
 *
 * resolveTier (role → 既定 tier) は llm.ts から import。
 */
import { resolveTier, type LlmRole } from "@/lib/llm";
import type {
  ModelEntry,
  TierAssignment,
  TierFallback,
  RoleTierOverrides,
} from "@/lib/model-registry";

export type GateViolation = { slot: string; entryId: string; reason: string };
export type TierSlot = { label: string; entryId: string | null; requiresTool: boolean };

/** role の既定 tier が tool 必須枠 (main/heavy) か。 */
export function roleRequiresTool(role: string): boolean {
  const tier = resolveTier(role as LlmRole);
  return tier === "main" || tier === "heavy";
}

/**
 * tool 必須スロットが `supportsTools===true` の entry を指しているか検証。
 * requiresTool=false / entryId=null のスロットは無視。違反を配列で返す (空 = OK)。
 */
export function checkToolSlots(
  slots: TierSlot[],
  entriesById: Map<string, ModelEntry>
): GateViolation[] {
  const violations: GateViolation[] = [];
  for (const s of slots) {
    if (!s.requiresTool || !s.entryId) continue;
    const e = entriesById.get(s.entryId);
    if (!e) {
      violations.push({ slot: s.label, entryId: s.entryId, reason: "entry が存在しません" });
      continue;
    }
    if (e.capabilities.supportsTools !== true) {
      violations.push({ slot: s.label, entryId: s.entryId, reason: "tool 未対応 (未テスト含む)" });
    }
  }
  return violations;
}

/**
 * entry id が tier 割当 / fallback / role 上書きに直接参照されている箇所を列挙 (削除ガード用)。
 * tier 名経由の間接参照は含めない (= それは assignment 削除ガードが守る)。
 */
export function findEntryReferences(
  id: string,
  assignment: TierAssignment,
  fallback: TierFallback,
  roleOverrides: RoleTierOverrides
): string[] {
  const refs: string[] = [];
  const tiers: Array<keyof TierAssignment> = ["main", "sub", "heavy"];
  const tierLabel: Record<string, string> = { main: "メイン", sub: "サブ", heavy: "ヘビー" };
  for (const t of tiers) {
    if (assignment[t] === id) refs.push(`tier 割当 (${tierLabel[t]})`);
    if (fallback[t] === id) refs.push(`fallback (${tierLabel[t]})`);
  }
  for (const [role, val] of Object.entries(roleOverrides)) {
    if (val === id) {
      refs.push(`role 上書き (${role})`);
    } else if ((val === "main" || val === "sub" || val === "heavy") && assignment[val] === id) {
      // tier 名経由の間接参照も「なぜ消せないか」表示に含める (Codex 中-2)。
      refs.push(`role 上書き (${role} → ${tierLabel[val]})`);
    }
  }
  return refs;
}
