/**
 * Project Links (M:N) API — Phase 0
 *
 * project_links テーブル (project_id × artifact_type × artifact_id) の CRUD。
 * AI suggest は Phase 1 で /api/project-links/suggest に分けて実装。
 *
 * ## 入出力 (JSON)
 *
 * ### GET /api/project-links?artifactType=&artifactId=
 *   ある artifact が紐付いてる project 一覧を返す。
 *   response: { projects: Array<{ id, name, color, linkedBy }> }
 *
 * ### GET /api/project-links?projectId=&artifactType=
 *   ある project に紐付いてる artifact 一覧 (任意で type 絞込み)。
 *   response: { artifacts: Array<{ artifactType, artifactId, linkedBy, linkedAt }> }
 *
 * ### POST /api/project-links
 *   body: { projectId, artifactType, artifactId, linkedBy? }
 *   単一 link を作成。conflict 時は no-op。
 *
 * ### POST /api/project-links/bulk
 *   body: { artifactType, artifactId, projectIds: number[], linkedBy? }
 *   同 artifact の link を差分更新 (チップ複数編集 UI 用)。primary 由来は保持。
 *
 * ### DELETE /api/project-links?projectId=&artifactType=&artifactId=
 *   単一 link を削除。
 *
 * ## 新しい artifact_type を増やす時
 *   artifactType に新しい文字列 (例: "memo") を渡せばそのまま通る。
 *   サーバ側で実体テーブル join したい場合は project-links.ts の
 *   cleanupOrphanLinks() に同 type の DELETE 文を 1 個追加すれば良い。
 *
 * 設計: docs/roadmap.md §6.8 (project-links)
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  attachLink,
  detachLink,
  setLinksForArtifact,
  listProjectsForArtifact,
  listProjectsForArtifactsBatch,
  listArtifactsForProject,
  type ArtifactType,
  type LinkedBy,
} from "@/lib/project-links";

export const dynamic = "force-dynamic";

const VALID_TYPES: ReadonlySet<ArtifactType> = new Set<ArtifactType>([
  "todo",
  "mail",
  "event",
  "contact",
  "memo",
]);
const VALID_LINKED_BY: ReadonlySet<LinkedBy> = new Set<LinkedBy>([
  "manual",
  "ai",
  "intent",
  "primary",
]);

function validType(s: string | null | undefined): ArtifactType | null {
  if (!s) return null;
  return VALID_TYPES.has(s as ArtifactType) ? (s as ArtifactType) : null;
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const projectIdRaw = sp.get("projectId");
  const artifactType = validType(sp.get("artifactType"));
  const artifactId = sp.get("artifactId");

  // GET (artifact -> projects)
  if (artifactType && artifactId) {
    const projects = await listProjectsForArtifact({ artifactType, artifactId });
    return NextResponse.json({ projects });
  }

  // GET (artifacts batch -> { [id]: projects[] })
  //   ?artifactType=event&artifactIds=id1,id2,id3
  //   Calendar 等で月分の event 全部に対する project 紐付きを 1 リクエストで取る用。
  const artifactIdsRaw = sp.get("artifactIds");
  if (artifactType && artifactIdsRaw) {
    const ids = artifactIdsRaw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    const map = await listProjectsForArtifactsBatch({ artifactType, artifactIds: ids });
    const byId: Record<string, Array<{ id: number; name: string; color: string | null; linkedBy: LinkedBy }>> = {};
    for (const id of ids) byId[id] = map.get(id) ?? [];
    return NextResponse.json({ byId });
  }

  // GET (project -> artifacts)
  if (projectIdRaw) {
    const projectId = parseInt(projectIdRaw, 10);
    if (!Number.isFinite(projectId) || projectId <= 0) {
      return NextResponse.json({ error: "invalid projectId" }, { status: 400 });
    }
    const artifacts = await listArtifactsForProject({
      projectId,
      artifactType: artifactType ?? undefined,
    });
    return NextResponse.json({
      artifacts: artifacts.map((a) => ({
        artifact_type: a.artifactType,
        artifact_id: a.artifactId,
        linked_by: a.linkedBy,
        linked_at: a.linkedAt.toISOString(),
      })),
    });
  }

  return NextResponse.json(
    { error: "either (artifactType & artifactId) or projectId required" },
    { status: 400 }
  );
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | {
        projectId?: number;
        artifactType?: string;
        artifactId?: string;
        linkedBy?: string;
        projectIds?: number[]; // bulk path
      }
    | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const artifactType = validType(body.artifactType);
  if (!artifactType) {
    return NextResponse.json({ error: "invalid artifactType" }, { status: 400 });
  }
  if (typeof body.artifactId !== "string" || body.artifactId.length === 0) {
    return NextResponse.json({ error: "artifactId required" }, { status: 400 });
  }
  const linkedBy =
    body.linkedBy && VALID_LINKED_BY.has(body.linkedBy as LinkedBy)
      ? (body.linkedBy as LinkedBy)
      : "manual";

  // bulk path: { artifactType, artifactId, projectIds: [...] } で差分更新
  if (Array.isArray(body.projectIds)) {
    const ids = body.projectIds.filter(
      (n) => typeof n === "number" && Number.isFinite(n) && n > 0
    );
    await setLinksForArtifact({
      artifactType,
      artifactId: body.artifactId,
      projectIds: ids,
      linkedBy,
    });
    const projects = await listProjectsForArtifact({
      artifactType,
      artifactId: body.artifactId,
    });
    return NextResponse.json({ projects });
  }

  // single path: { projectId, artifactType, artifactId } で 1 件 attach
  if (typeof body.projectId !== "number" || !Number.isFinite(body.projectId)) {
    return NextResponse.json({ error: "projectId required" }, { status: 400 });
  }
  await attachLink({
    projectId: body.projectId,
    artifactType,
    artifactId: body.artifactId,
    linkedBy,
  });
  const projects = await listProjectsForArtifact({
    artifactType,
    artifactId: body.artifactId,
  });
  return NextResponse.json({ projects });
}

export async function DELETE(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const projectIdRaw = sp.get("projectId");
  const artifactType = validType(sp.get("artifactType"));
  const artifactId = sp.get("artifactId");

  const projectId = parseInt(projectIdRaw ?? "", 10);
  if (
    !artifactType ||
    !artifactId ||
    !Number.isFinite(projectId) ||
    projectId <= 0
  ) {
    return NextResponse.json(
      { error: "projectId, artifactType, artifactId required" },
      { status: 400 }
    );
  }
  await detachLink({ projectId, artifactType, artifactId });
  return NextResponse.json({ ok: true });
}
