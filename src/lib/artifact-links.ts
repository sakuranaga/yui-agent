/**
 * artifact_links (source → target、polymorphic M:N) の操作ヘルパー。
 *
 * intent dispatch (mail → todo / event → todo 等) で target を作る時に書き込んで、
 * 後から target 側で「出典」を辿るための back-link を管理する。
 *
 * 設計: docs/roadmap.md §6.9 (intent endpoint Phase B)
 */
import { db } from "@/db/client";
import { artifactLinks } from "@/db/schema";
import { and, eq } from "drizzle-orm";

export type SourceType = "mail" | "event" | "todo" | "contact" | "diary";
export type TargetType = "todo" | "event" | "contact" | "memo";
export type CreatedBy = "intent" | "manual";

export async function attachArtifactLink(opts: {
  sourceType: SourceType;
  sourceId: string;
  targetType: TargetType;
  targetId: string;
  createdBy?: CreatedBy;
}): Promise<void> {
  await db
    .insert(artifactLinks)
    .values({
      sourceType: opts.sourceType,
      sourceId: opts.sourceId,
      targetType: opts.targetType,
      targetId: opts.targetId,
      createdBy: opts.createdBy ?? "intent",
    })
    .onConflictDoNothing();
}

export async function detachArtifactLink(opts: {
  sourceType: SourceType;
  sourceId: string;
  targetType: TargetType;
  targetId: string;
}): Promise<void> {
  await db
    .delete(artifactLinks)
    .where(
      and(
        eq(artifactLinks.sourceType, opts.sourceType),
        eq(artifactLinks.sourceId, opts.sourceId),
        eq(artifactLinks.targetType, opts.targetType),
        eq(artifactLinks.targetId, opts.targetId)
      )
    );
}

/** target 側で「自分はどこから作られたか」を引く。複数 source あり得る (M:N)。 */
export async function listSourcesForTarget(opts: {
  targetType: TargetType;
  targetId: string;
}): Promise<Array<{ sourceType: SourceType; sourceId: string; createdBy: CreatedBy; createdAt: Date }>> {
  const rows = await db
    .select()
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.targetType, opts.targetType),
        eq(artifactLinks.targetId, opts.targetId)
      )
    );
  return rows.map((r) => ({
    sourceType: r.sourceType,
    sourceId: r.sourceId,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }));
}

/** source 側で「ここから何が作られたか」を引く。Mail 詳細での「派生 TODO 一覧」用。 */
export async function listTargetsForSource(opts: {
  sourceType: SourceType;
  sourceId: string;
}): Promise<Array<{ targetType: TargetType; targetId: string; createdBy: CreatedBy; createdAt: Date }>> {
  const rows = await db
    .select()
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.sourceType, opts.sourceType),
        eq(artifactLinks.sourceId, opts.sourceId)
      )
    );
  return rows.map((r) => ({
    targetType: r.targetType,
    targetId: r.targetId,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }));
}
