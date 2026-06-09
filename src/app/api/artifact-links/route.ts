/**
 * Artifact Links API (source → target、polymorphic M:N、back-link).
 *
 * intent dispatch (mail → todo / event → todo 等) で target を作る時に書く。
 * 後から target 側で「出典」を辿る、source 側で「派生」を辿る、両方向で使う。
 *
 * ## GET /api/artifact-links?targetType=&targetId=
 *   ある target の出典 source 一覧。
 *   response: { sources: Array<{ source_type, source_id, created_by, created_at }> }
 *
 * ## GET /api/artifact-links?sourceType=&sourceId=
 *   ある source の派生 target 一覧。
 *   response: { targets: Array<{ target_type, target_id, created_by, created_at }> }
 *
 * ## POST /api/artifact-links
 *   body: { sourceType, sourceId, targetType, targetId, createdBy? }
 *   PK conflict は no-op。
 *
 * ## DELETE /api/artifact-links?sourceType=&sourceId=&targetType=&targetId=
 *
 * ## 新しい source / target を増やす時
 *   - artifact-links.ts の SourceType / TargetType union に追加
 *   - 該当 modal が「出典」表示 + ジャンプ動線を実装
 *
 * 設計: docs/roadmap.md §6.9 (intent endpoint Phase B)
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  attachArtifactLink,
  detachArtifactLink,
  listSourcesForTarget,
  listTargetsForSource,
  type SourceType,
  type TargetType,
  type CreatedBy,
} from "@/lib/artifact-links";

export const dynamic = "force-dynamic";

const VALID_SOURCES = new Set<SourceType>(["mail", "event", "todo", "contact", "diary"]);
const VALID_TARGETS = new Set<TargetType>(["todo", "event", "contact", "memo"]);
const VALID_CREATED_BY = new Set<CreatedBy>(["intent", "manual"]);

function asSource(s: string | null | undefined): SourceType | null {
  return s && VALID_SOURCES.has(s as SourceType) ? (s as SourceType) : null;
}
function asTarget(s: string | null | undefined): TargetType | null {
  return s && VALID_TARGETS.has(s as TargetType) ? (s as TargetType) : null;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const targetType = asTarget(sp.get("targetType"));
  const targetId = sp.get("targetId");
  const sourceType = asSource(sp.get("sourceType"));
  const sourceId = sp.get("sourceId");

  if (targetType && targetId) {
    const sources = await listSourcesForTarget({ targetType, targetId });
    return NextResponse.json({
      sources: sources.map((s) => ({
        source_type: s.sourceType,
        source_id: s.sourceId,
        created_by: s.createdBy,
        created_at: s.createdAt.toISOString(),
      })),
    });
  }
  if (sourceType && sourceId) {
    const targets = await listTargetsForSource({ sourceType, sourceId });
    return NextResponse.json({
      targets: targets.map((t) => ({
        target_type: t.targetType,
        target_id: t.targetId,
        created_by: t.createdBy,
        created_at: t.createdAt.toISOString(),
      })),
    });
  }
  return NextResponse.json(
    { error: "either (targetType & targetId) or (sourceType & sourceId) required" },
    { status: 400 }
  );
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | {
        sourceType?: string;
        sourceId?: string;
        targetType?: string;
        targetId?: string;
        createdBy?: string;
      }
    | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });
  const st = asSource(body.sourceType);
  const tt = asTarget(body.targetType);
  if (!st || !tt || !body.sourceId || !body.targetId) {
    return NextResponse.json(
      { error: "sourceType / sourceId / targetType / targetId required" },
      { status: 400 }
    );
  }
  const createdBy =
    body.createdBy && VALID_CREATED_BY.has(body.createdBy as CreatedBy)
      ? (body.createdBy as CreatedBy)
      : "intent";
  await attachArtifactLink({
    sourceType: st,
    sourceId: body.sourceId,
    targetType: tt,
    targetId: body.targetId,
    createdBy,
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const st = asSource(sp.get("sourceType"));
  const tt = asTarget(sp.get("targetType"));
  const sourceId = sp.get("sourceId");
  const targetId = sp.get("targetId");
  if (!st || !tt || !sourceId || !targetId) {
    return NextResponse.json(
      { error: "sourceType / sourceId / targetType / targetId required" },
      { status: 400 }
    );
  }
  await detachArtifactLink({
    sourceType: st,
    sourceId,
    targetType: tt,
    targetId,
  });
  return NextResponse.json({ ok: true });
}
