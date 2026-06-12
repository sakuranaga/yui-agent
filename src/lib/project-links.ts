/**
 * project_links (ポリモーフィック M:N) の操作ヘルパー。
 *
 * 設計哲学: intent endpoint と同じ — ポリモーフィックな artifact_type を
 * 受け入れて、新ツール追加時はここを変更せずに済むようにする。
 *
 * artifact_type の許容値:
 *   "todo" | "mail" | "event" | "contact" | "memo"  ← TS 型で制約
 *
 * 連動関係:
 *   - todos.project_id は primary project として温存。`linked_by="primary"` で
 *     project_links 側にも複写されている (migration 0041 で過去分は初期化済)。
 *   - 新規 TODO 作成時に todos.project_id を設定したら、本ヘルパーの attach()
 *     を `linked_by="primary"` で呼んで両者を同期する責任は caller 側。
 */
import { db } from "@/db/client";
import { projectLinks, projects, type ProjectLink } from "@/db/schema";
import { and, asc, eq, inArray, sql } from "drizzle-orm";

export type ArtifactType = "todo" | "mail" | "event" | "contact" | "memo";
export type LinkedBy = "manual" | "ai" | "intent" | "primary";

/** 単一 link を作成。既存ならアップデートせず no-op (PRIMARY KEY conflict → ignore)。 */
export async function attachLink(opts: {
  projectId: number;
  artifactType: ArtifactType;
  artifactId: string;
  linkedBy?: LinkedBy;
}): Promise<void> {
  await db
    .insert(projectLinks)
    .values({
      projectId: opts.projectId,
      artifactType: opts.artifactType,
      artifactId: opts.artifactId,
      linkedBy: opts.linkedBy ?? "manual",
    })
    .onConflictDoNothing();
}

/** 単一 link を削除。 */
export async function detachLink(opts: {
  projectId: number;
  artifactType: ArtifactType;
  artifactId: string;
}): Promise<void> {
  await db
    .delete(projectLinks)
    .where(
      and(
        eq(projectLinks.projectId, opts.projectId),
        eq(projectLinks.artifactType, opts.artifactType),
        eq(projectLinks.artifactId, opts.artifactId)
      )
    );
}

/** 同一 artifact のリンクを差分更新 (UI で複数 project を chip 編集する用)。 */
export async function setLinksForArtifact(opts: {
  artifactType: ArtifactType;
  artifactId: string;
  projectIds: number[];
  linkedBy?: LinkedBy;
}): Promise<void> {
  const existing = await db
    .select({ projectId: projectLinks.projectId, linkedBy: projectLinks.linkedBy })
    .from(projectLinks)
    .where(
      and(
        eq(projectLinks.artifactType, opts.artifactType),
        eq(projectLinks.artifactId, opts.artifactId)
      )
    );
  const desired = new Set(opts.projectIds);
  const current = new Map(existing.map((e) => [e.projectId, e.linkedBy]));

  // 追加分
  const toAdd = opts.projectIds.filter((id) => !current.has(id));
  if (toAdd.length > 0) {
    await db
      .insert(projectLinks)
      .values(
        toAdd.map((id) => ({
          projectId: id,
          artifactType: opts.artifactType,
          artifactId: opts.artifactId,
          linkedBy: opts.linkedBy ?? "manual",
        }))
      )
      .onConflictDoNothing();
  }

  // 削除分 (primary は維持: TODO の todos.project_id が真として残るため、
  // ここで primary を消さない。primary 変更は別途 todos.project_id 経由)
  const toRemove = existing
    .filter((e) => !desired.has(e.projectId) && e.linkedBy !== "primary")
    .map((e) => e.projectId);
  if (toRemove.length > 0) {
    await db
      .delete(projectLinks)
      .where(
        and(
          eq(projectLinks.artifactType, opts.artifactType),
          eq(projectLinks.artifactId, opts.artifactId),
          inArray(projectLinks.projectId, toRemove)
        )
      );
  }
}

/** ある artifact が紐付いてる project の一覧 (名前 / 色含む)。 */
/**
 * 複数 artifact の project 紐付きを 1 クエリで取得 (Calendar 等で N+1 を避ける用)。
 * 結果は artifactId → projects[] の Map。
 */
export async function listProjectsForArtifactsBatch(opts: {
  artifactType: ArtifactType;
  artifactIds: string[];
}): Promise<
  Map<string, Array<{ id: number; name: string; color: string | null; linkedBy: LinkedBy }>>
> {
  const out = new Map<
    string,
    Array<{ id: number; name: string; color: string | null; linkedBy: LinkedBy }>
  >();
  if (opts.artifactIds.length === 0) return out;
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      color: projects.color,
      linkedBy: projectLinks.linkedBy,
      artifactId: projectLinks.artifactId,
    })
    .from(projectLinks)
    .innerJoin(projects, eq(projects.id, projectLinks.projectId))
    .where(
      and(
        eq(projectLinks.artifactType, opts.artifactType),
        inArray(projectLinks.artifactId, opts.artifactIds)
      )
    )
    .orderBy(asc(projects.sortOrder), asc(projects.name));
  for (const r of rows) {
    const list = out.get(r.artifactId) ?? [];
    list.push({
      id: Number(r.id),
      name: r.name,
      color: r.color,
      linkedBy: (r.linkedBy ?? "manual") as LinkedBy,
    });
    out.set(r.artifactId, list);
  }
  return out;
}

export async function listProjectsForArtifact(opts: {
  artifactType: ArtifactType;
  artifactId: string;
}): Promise<
  Array<{ id: number; name: string; color: string | null; linkedBy: LinkedBy }>
> {
  const rows = await db
    .select({
      id: projects.id,
      name: projects.name,
      color: projects.color,
      linkedBy: projectLinks.linkedBy,
    })
    .from(projectLinks)
    .innerJoin(projects, eq(projects.id, projectLinks.projectId))
    .where(
      and(
        eq(projectLinks.artifactType, opts.artifactType),
        eq(projectLinks.artifactId, opts.artifactId)
      )
    )
    .orderBy(asc(projects.sortOrder), asc(projects.name));
  return rows.map((r) => ({
    id: Number(r.id),
    name: r.name,
    color: r.color,
    linkedBy: (r.linkedBy ?? "manual") as LinkedBy,
  }));
}

/**
 * ある project に紐付いてる artifact 一覧 (artifact_type ごと)。
 * 個別の本体データ (件名 / タイトル等) は caller が必要に応じて join する。
 * ここでは ID 列挙のみ。
 */
export async function listArtifactsForProject(opts: {
  projectId: number;
  artifactType?: ArtifactType;
}): Promise<Array<{ artifactType: ArtifactType; artifactId: string; linkedBy: LinkedBy; linkedAt: Date }>> {
  const where = opts.artifactType
    ? and(
        eq(projectLinks.projectId, opts.projectId),
        eq(projectLinks.artifactType, opts.artifactType)
      )
    : eq(projectLinks.projectId, opts.projectId);
  const rows = await db
    .select()
    .from(projectLinks)
    .where(where)
    .orderBy(asc(projectLinks.linkedAt));
  return rows.map((r: ProjectLink) => ({
    artifactType: r.artifactType,
    artifactId: r.artifactId,
    linkedBy: r.linkedBy,
    linkedAt: r.linkedAt,
  }));
}

/**
 * ある project に紐付いてる artifact 件数 (artifact_type ごとに集計)。
 * Hub の project 一覧で project 横にバッジで出す用。
 */
export async function countArtifactsByType(projectId: number): Promise<
  Partial<Record<ArtifactType, number>>
> {
  const rows = await db
    .select({
      artifactType: projectLinks.artifactType,
      n: sql<number>`count(*)::int`,
    })
    .from(projectLinks)
    .where(eq(projectLinks.projectId, projectId))
    .groupBy(projectLinks.artifactType);
  const out: Partial<Record<ArtifactType, number>> = {};
  for (const r of rows) out[r.artifactType] = Number(r.n);
  return out;
}

/**
 * Orphan cleanup: 各 artifact 種について、本体テーブルに存在しない artifact_id
 * の project_link を削除。FK 整合性を保たないトレードオフを掃除で補う。
 * 定期 cron で呼ぶ想定 (1 日 1 回程度)。
 */
export async function cleanupOrphanLinks(): Promise<{ removed: number }> {
  // PostgreSQL の NOT IN (SELECT id) は join + WHERE で書く方が plan が安定。
  // 各 artifact_type ごとに「本体に存在しない id」を削除。
  let removed = 0;
  // todo
  const r1 = await db.execute(sql`
    DELETE FROM project_links
    WHERE artifact_type = 'todo'
      AND artifact_id::bigint NOT IN (SELECT id FROM todos)
  `);
  removed += (r1 as unknown as { rowCount?: number }).rowCount ?? 0;
  // contact
  const r2 = await db.execute(sql`
    DELETE FROM project_links
    WHERE artifact_type = 'contact'
      AND artifact_id::bigint NOT IN (SELECT id FROM contacts)
  `);
  removed += (r2 as unknown as { rowCount?: number }).rowCount ?? 0;
  // memo (= notes テーブル。deleteNote が同 transaction で消すのが本筋、これは保険)
  const r3 = await db.execute(sql`
    DELETE FROM project_links
    WHERE artifact_type = 'memo'
      AND artifact_id::bigint NOT IN (SELECT id FROM notes)
  `);
  removed += (r3 as unknown as { rowCount?: number }).rowCount ?? 0;
  // mail / event は外部 ID を持つので skip
  return { removed };
}
