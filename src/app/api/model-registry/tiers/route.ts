/**
 * GET /api/model-registry/tiers → { assignment, fallback, roleOverrides } (#206 M4)
 * PUT /api/model-registry/tiers → partial 保存 (マージ後の最終状態に能力ゲートを適用)
 *
 * cookie 認証 (proxy.ts、PUBLIC_PATHS 外) 前提。
 * 設計: docs/model-config-overhaul.md §8.6.1
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  listModels,
  getTierAssignment,
  setTierAssignment,
  getTierFallback,
  setTierFallback,
  getRoleTierOverrides,
  setRoleTierOverrides,
  type ModelEntry,
  type TierAssignment,
  type TierFallback,
  type RoleTierOverrides,
} from "@/lib/model-registry";
import { checkToolSlots, roleRequiresTool, type TierSlot } from "@/lib/model-tier-gate";
import { isLlmRole } from "@/lib/llm";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const [assignment, fallback, roleOverrides] = await Promise.all([
      getTierAssignment(),
      getTierFallback(),
      getRoleTierOverrides(),
    ]);
    return NextResponse.json({ assignment, fallback, roleOverrides });
  } catch (e) {
    return clientError(undefined, e, { context: "model-registry/tiers/get", message: "tier 設定の取得に失敗しました" });
  }
}

export async function PUT(req: NextRequest) {
  let body: {
    assignment?: Partial<TierAssignment>;
    fallback?: Partial<TierFallback>;
    roleOverrides?: RoleTierOverrides;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400 });
  }

  try {
    const [curAssignment, curFallback, curOverrides, entries] = await Promise.all([
      getTierAssignment(),
      getTierFallback(),
      getRoleTierOverrides(),
      listModels(),
    ]);

    // partial を既存とマージ。
    const assignment: TierAssignment = { ...curAssignment, ...(body.assignment ?? {}) };
    const fallback: TierFallback = { ...curFallback, ...(body.fallback ?? {}) };
    const roleOverrides: RoleTierOverrides = body.roleOverrides ?? curOverrides;

    // ゲートは「この PUT で変更されたスロットだけ」に適用する (seed 由来の未テスト entry を
    // grandfather し、無関係な変更を過剰にブロックしない)。main/heavy スロットは独立なので
    // 変更スロットのみの検証で漏れは出ない。
    const tiers: Array<"main" | "sub" | "heavy" | "tool"> = ["main", "sub", "heavy", "tool"];
    const requiresTool = (t: "main" | "sub" | "heavy" | "tool") => t === "main" || t === "heavy" || t === "tool";
    const slots: TierSlot[] = [];
    for (const t of tiers) {
      if (body.assignment && t in body.assignment && assignment[t] !== curAssignment[t]) {
        slots.push({ label: `tier (${t})`, entryId: assignment[t], requiresTool: requiresTool(t) });
      }
      if (body.fallback && t in body.fallback && fallback[t] !== curFallback[t]) {
        slots.push({ label: `fallback (${t})`, entryId: fallback[t], requiresTool: requiresTool(t) });
      }
    }
    const byId = new Map<string, ModelEntry>(entries.map((e) => [e.id, e]));

    if (body.roleOverrides) {
      for (const [role, val] of Object.entries(roleOverrides)) {
        // role 上書きの値は **実在 entry id のみ** に限定。tier 名指定は、tool 必須 role が tier を
        // 指すと assignment/fallback 双方に tool 制約が波及し cross-dependency ゲートが複雑化・
        // 抜けやすくなるため API からは作らせない (UI / 移行も entry id しか書かない)。
        // resolveEntry は tier 名も読める (防御) が、生成経路は entry id に統一する。
        if (!isLlmRole(role) || !byId.has(val)) {
          return NextResponse.json(
            { error: `role 上書きは既知の役割 + 登録済みモデルのみ指定できます (role=${role})` },
            { status: 400 }
          );
        }
        if (curOverrides[role] === val) continue; // 未変更は再検証しない
        slots.push({ label: `role 上書き (${role})`, entryId: val, requiresTool: roleRequiresTool(role) });
      }
    }

    const violations = checkToolSlots(slots, byId);
    if (violations.length > 0) {
      return NextResponse.json(
        {
          error: "tool 未対応のモデルは メイン / ヘビー / ツール選択 枠に割り当てできません。先に接続テストで tool 対応を確認してください。",
          violations,
        },
        { status: 422 }
      );
    }

    // 検証 OK → 渡された分だけ保存。
    if (body.assignment !== undefined) await setTierAssignment(assignment);
    if (body.fallback !== undefined) await setTierFallback(fallback);
    if (body.roleOverrides !== undefined) await setRoleTierOverrides(roleOverrides);

    return NextResponse.json({ assignment, fallback, roleOverrides });
  } catch (e) {
    return clientError(req, e, { context: "model-registry/tiers/put", message: "tier 設定の保存に失敗しました" });
  }
}
