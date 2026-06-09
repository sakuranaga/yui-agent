/**
 * POST /api/intent
 *
 * Cross-tool dispatch: source アーティファクト (mail / event / todo / contact /
 * diary) を Gemma 経由で別 target ツール (todo / event / contact / memo) の
 * draft に構造化変換する。client は受け取った draft を該当 modal に pre-fill
 * して作成フォームを開く運用。
 *
 * Yui (Sonnet) は使わない — 人格不要な構造化タスクなので local LLM (Gemma) で
 * 十分。project-suggest endpoint と同じ哲学。
 *
 * ## 入力 (body)
 *   {
 *     "source": ArtifactPayload,        // artifact-payloads.ts の polymorphic union
 *     "target": "todo" | "event" | "contact" | "memo",
 *     "sourceRefId"?: string            // 任意。指定すると project_links から
 *                                       // 紐付き project_id を inherit
 *   }
 *
 * ## 出力
 *   {
 *     "draft": TargetDraft | null,      // intent-transform.ts の各 schema 参照
 *     "inheritedProjectIds": number[],  // sourceRefId が指定された時の自動継承
 *     "raw"?: string,                   // Gemma の生 output (debug)
 *     "warning"?: string                // 失敗時のみ (invalid_json_after_retry / llm_error 等)
 *   }
 *
 * ## クライアント側の運用
 *   - draft が null なら fallback (source data を最低限の項目に埋め込んで
 *     modal を開く + toast でユーザに知らせる)
 *   - inheritedProjectIds は target 作成後に POST /api/project-links に流す
 *   - target modal はそれぞれ「intent draft で開く」専用パスを持つ
 *
 * ## 新しい source ツール / target ツールを増やす手順
 *   - source: artifact-payloads.ts の ArtifactPayload union に追加 +
 *     formatArtifactForLlm() の switch に format 関数を追加
 *   - target: intent-transform.ts の TARGET_SCHEMA + TARGET_LABEL +
 *     TargetTool union に追加 + validateDraft() に case 追加
 *   - 該当 modal が "yui-intent-draft" event を listen して新規作成フォームを
 *     pre-fill で開く実装も追加
 *
 * 設計: docs/roadmap.md §6.9 (intent endpoint)
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  transformIntent,
  type TargetTool,
} from "@/lib/intent-transform";
import type { ArtifactPayload } from "@/lib/artifact-payloads";
import { listProjectsForArtifact, type ArtifactType } from "@/lib/project-links";
import { db } from "@/db/client";
import { todos, projects, artifactLinks } from "@/db/schema";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";

export const dynamic = "force-dynamic";

const VALID_SOURCE_TYPES = new Set(["mail", "event", "todo", "contact", "diary"]);
const VALID_TARGETS = new Set<TargetTool>(["todo", "event", "contact", "memo"]);

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as
    | {
        source?: { type?: string; data?: unknown };
        target?: string;
        sourceRefId?: string;
      }
    | null;
  if (!body) return NextResponse.json({ error: "invalid body" }, { status: 400 });

  const srcType = body.source?.type;
  if (
    typeof srcType !== "string" ||
    !VALID_SOURCE_TYPES.has(srcType) ||
    !body.source?.data ||
    typeof body.source.data !== "object"
  ) {
    return NextResponse.json(
      { error: "source.type and source.data required" },
      { status: 400 }
    );
  }
  const target = body.target as TargetTool | undefined;
  if (!target || !VALID_TARGETS.has(target)) {
    return NextResponse.json(
      { error: "target required, one of todo|event|contact|memo" },
      { status: 400 }
    );
  }

  const sourcePayload: ArtifactPayload = {
    type: srcType,
    data: body.source.data,
  } as ArtifactPayload;

  // 0) 高速 dedup プリチェック: artifact_links に back-link が既にあれば
  //    「この source から作られた active TODO」が既存。Gemma を呼ばずに即返却。
  //    title マッチより正確かつ index lookup なので ~10ms で済む。
  if (body.sourceRefId && target === "todo") {
    try {
      const linked = await db
        .select({
          todoId: todos.id,
          identifier: todos.identifier,
          title: todos.title,
          state: todos.state,
        })
        .from(artifactLinks)
        .innerJoin(todos, eq(todos.id, sql`${artifactLinks.targetId}::bigint`))
        .where(
          and(
            eq(artifactLinks.sourceType, srcType as
              | "mail" | "event" | "todo" | "contact" | "diary"),
            eq(artifactLinks.sourceId, body.sourceRefId),
            eq(artifactLinks.targetType, "todo"),
            inArray(todos.state, ["backlog", "in_progress", "blocked"])
          )
        )
        .limit(1);
      if (linked.length > 0) {
        const e = linked[0];
        return NextResponse.json({
          draft: null,
          inheritedProjects: [],
          inheritedProjectIds: [],
          dedupCheck: {
            existing: {
              id: Number(e.todoId),
              identifier: e.identifier,
              title: e.title,
            },
          },
          // Gemma を呼ばずに返した旨を客側で識別したい場合に
          skipped: "artifact_link_hit",
        });
      }
    } catch (e) {
      console.warn("[intent] artifact_link prefetch failed:", e);
    }
  }

  // 1) Gemma で draft 変換
  const result = await transformIntent(sourcePayload, target);

  // 2) source の紐付き project を継承候補として返す。
  //    UI 側で project chip 表示 + 1 つ目を primary project field に pre-fill するため、
  //    id だけでなく name / color も含めて返す。
  let inheritedProjects: Array<{ id: number; name: string; color: string | null }> = [];
  if (body.sourceRefId && srcType !== "diary") {
    try {
      const projs = await listProjectsForArtifact({
        artifactType: srcType as ArtifactType,
        artifactId: body.sourceRefId,
      });
      inheritedProjects = projs.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
      }));
    } catch (e) {
      console.warn("[intent] inherit project lookup failed:", e);
    }
  }

  // 3) target=todo の時、source 側で「既に同タイトル active TODO あり」をプリ判定。
  //    Mail kebab が TODO modal を開く前にトーストで知らせるために使う。
  //    project スコープは継承候補の 1 つ目 (primary 想定)。session は UI default。
  let dedupCheck: { existing: { id: number; identifier: string; title: string } | null } = {
    existing: null,
  };
  if (target === "todo" && result.draft && "title" in result.draft) {
    try {
      const sessionId = "ui";
      const normalized = result.draft.title.trim().toLowerCase().replace(/\s+/g, " ");
      let projectIdForCheck: number | null = null;
      if (inheritedProjects.length > 0) {
        const [p] = await db
          .select({ id: projects.id })
          .from(projects)
          .where(eq(projects.name, inheritedProjects[0].name))
          .limit(1);
        if (p) projectIdForCheck = Number(p.id);
      }
      const projectCond =
        projectIdForCheck === null
          ? isNull(todos.projectId)
          : eq(todos.projectId, projectIdForCheck);
      const [existing] = await db
        .select({
          id: todos.id,
          identifier: todos.identifier,
          title: todos.title,
        })
        .from(todos)
        .where(
          and(
            eq(todos.sessionId, sessionId),
            projectCond,
            sql`lower(regexp_replace(trim(${todos.title}), '\\s+', ' ', 'g')) = ${normalized}`,
            inArray(todos.state, ["backlog", "in_progress", "blocked"])
          )
        )
        .limit(1);
      if (existing) {
        dedupCheck = {
          existing: {
            id: Number(existing.id),
            identifier: existing.identifier,
            title: existing.title,
          },
        };
      }
    } catch (e) {
      console.warn("[intent] dedup check failed:", e);
    }
  }

  return NextResponse.json({
    draft: result.draft,
    inheritedProjects,
    // backward compat: 旧 inheritedProjectIds キーも残しておく
    inheritedProjectIds: inheritedProjects.map((p) => p.id),
    dedupCheck,
    raw: result.raw,
    warning: result.warning,
  });
}
