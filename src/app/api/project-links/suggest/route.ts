/**
 * POST /api/project-links/suggest
 *
 * アーティファクト (mail / event / todo / contact / diary) を渡すと、
 * Gemma (local LLM) が現在の active project 一覧と照合して、紐付け候補を
 * JSON で返す。client はしきい値を見て auto-attach / suggest UI 表示を切替。
 *
 * ## 入力 (body)
 *   ArtifactPayload (polymorphic、artifact-payloads.ts 参照)
 *   例: { "type": "mail", "data": { "subject": "...", "from": {...}, ... } }
 *
 * ## 出力
 *   {
 *     "suggestions": [
 *       { "projectId": <number>, "confidence": <0-1>, "reason": "<string>" }
 *     ],
 *     "warning"?: string   // LLM 失敗 / JSON parse 失敗時のみ
 *   }
 *
 * ## しきい値の運用 (推奨、UI 側で実装)
 *   confidence > 0.8  → 強く推奨 (auto-attach 候補)
 *   0.5 - 0.8         → 候補 (chip 提案、user click で attach)
 *   < 0.5             → 通常含めない (Gemma プロンプトで除外指示済)
 *
 * ## 新 artifact_type を増やす時
 *   artifact-payloads.ts 側を更新するだけでこの endpoint も自動対応する。
 *   endpoint 側の変更不要 (intent endpoint と同じ拡張性)。
 *
 * 設計: docs/roadmap.md §6.8 (project-links Phase 1)
 */
import { NextResponse, type NextRequest } from "next/server";
import { suggestProjects } from "@/lib/project-suggest";
import type { ArtifactPayload, ArtifactType } from "@/lib/artifact-payloads";

export const dynamic = "force-dynamic";

const VALID_TYPES: ReadonlySet<ArtifactType> = new Set<ArtifactType>([
  "mail",
  "event",
  "todo",
  "contact",
  "diary",
]);

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | { type?: string; data?: unknown }
    | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  if (
    typeof body.type !== "string" ||
    !VALID_TYPES.has(body.type as ArtifactType) ||
    !body.data ||
    typeof body.data !== "object"
  ) {
    return NextResponse.json(
      { error: "type and data required, type ∈ mail|event|todo|contact|diary" },
      { status: 400 }
    );
  }

  const payload = { type: body.type, data: body.data } as ArtifactPayload;
  const result = await suggestProjects(payload);
  return NextResponse.json(result);
}
