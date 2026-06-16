/**
 * PATCH  /api/model-registry/[id]  → モデル部分更新 (#206 M4)
 * DELETE /api/model-registry/[id]  → モデル削除 (参照中はガード)
 *
 * cookie 認証 (proxy.ts、PUBLIC_PATHS 外) 前提。
 * 設計: docs/model-config-overhaul.md §8.6.1
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  getModel,
  updateModel,
  deleteModel,
  sanitizeLocalBaseUrl,
  getTierAssignment,
  getTierFallback,
  getRoleTierOverrides,
} from "@/lib/model-registry";
import { findEntryReferences, roleRequiresTool } from "@/lib/model-tier-gate";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const entry = await getModel(id);
    if (!entry) return NextResponse.json({ error: "モデルが見つかりません" }, { status: 404 });

    let body: { label?: string; modelId?: string; baseUrl?: string };
    try {
      body = (await req.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "JSON が不正です" }, { status: 400 });
    }

    const patch: { label?: string; modelId?: string; baseUrl?: string | null; capabilities?: Record<string, never> } = {};
    if (body.label !== undefined) {
      const label = body.label.trim();
      if (!label) return NextResponse.json({ error: "ラベルは空にできません" }, { status: 400 });
      patch.label = label;
    }

    // modelId / baseUrl の変更は「実体が変わる」= 古い能力テスト結果を持ち越せない (§8.6.1 高-1)。
    const modelIdChanged = body.modelId !== undefined && body.modelId.trim() !== entry.modelId;
    let baseUrlChanged = false;
    if (body.modelId !== undefined) {
      const m = body.modelId.trim();
      if (!m) return NextResponse.json({ error: "モデル ID は空にできません" }, { status: 400 });
      patch.modelId = m;
    }
    if (body.baseUrl !== undefined) {
      if (entry.provider === "local_openai") {
        const v = sanitizeLocalBaseUrl(body.baseUrl ?? "");
        if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
        if (v.value !== entry.baseUrl) {
          patch.baseUrl = v.value;
          baseUrlChanged = true;
        }
      }
      // hosted は base_url を持たないので無視。
    }

    if (modelIdChanged || baseUrlChanged) {
      // tool 必須スロットに使用中なら、実体変更を拒否 (= 先に外すか再テストさせる)。
      const [assignment, fallback, roleOverrides] = await Promise.all([
        getTierAssignment(),
        getTierFallback(),
        getRoleTierOverrides(),
      ]);
      // role 上書きは entry id 直指定のみ (tier 名は API で作れない、tiers route 参照)。
      // なので「main/heavy role が entry id で直接この entry を指す」だけ tool 必須参照として扱う。
      const toolRequiredRefs = [
        assignment.main === id ? "メイン" : null,
        assignment.heavy === id ? "ヘビー" : null,
        fallback.main === id ? "メイン fallback" : null,
        fallback.heavy === id ? "ヘビー fallback" : null,
        ...Object.entries(roleOverrides)
          .filter(([role, val]) => val === id && roleRequiresTool(role)) // main/heavy role の entry id 直指定
          .map(([role]) => `role 上書き (${role})`),
      ].filter((s): s is string => s !== null);
      if (toolRequiredRefs.length > 0) {
        return NextResponse.json(
          {
            error: "tool 必須スロットで使用中のため、モデル ID / base_url は変更できません。先に割当を外すか、別モデルに替えてください。",
            references: toolRequiredRefs,
          },
          { status: 409 }
        );
      }
      // 未参照 (または sub のみ参照) → 能力テスト結果をリセット (再テスト必須に)。
      patch.capabilities = {};
    }

    const updated = await updateModel(id, patch);
    if (!updated) return NextResponse.json({ error: "モデルが見つかりません" }, { status: 404 });
    return NextResponse.json({ entry: updated });
  } catch (e) {
    return clientError(req, e, { context: "model-registry/update", message: "モデルの更新に失敗しました" });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const entry = await getModel(id);
    if (!entry) return NextResponse.json({ error: "モデルが見つかりません" }, { status: 404 });

    const [assignment, fallback, roleOverrides] = await Promise.all([
      getTierAssignment(),
      getTierFallback(),
      getRoleTierOverrides(),
    ]);
    const refs = findEntryReferences(id, assignment, fallback, roleOverrides);
    if (refs.length > 0) {
      return NextResponse.json(
        { error: "使用中のため削除できません。先に割当を外してください。", references: refs },
        { status: 409 }
      );
    }

    const ok = await deleteModel(id);
    if (!ok) return NextResponse.json({ error: "モデルが見つかりません" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "model-registry/delete", message: "モデルの削除に失敗しました" });
  }
}
