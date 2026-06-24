/**
 * POST /api/todos/batch — 複数 TODO の一括部分更新
 * Body: { ids: number[], patch: { project?, state?, priority?, tags?, start_at?, due_at? } }
 *   - patch は「変更したフィールドだけ」。含まれるキーのみ全 ids へ適用する。
 *   - project: プロジェクト名 | null (Inbox)。state/priority/tags/start_at/due_at は単票 PATCH と同義。
 *   - 真の atomic ではなく best-effort 逐次。id ごとの失敗は固定コードで返す。
 */
import { NextResponse, type NextRequest } from "next/server";
import { batchUpdateTodos, type BatchTodoPatch } from "@/lib/todos";
import { clientError } from "@/lib/api-error";

const STATES = ["backlog", "in_progress", "blocked", "done", "cancelled"] as const;
const MAX_IDS = 500;

type BodyPatch = {
  project?: string | null;
  state?: string;
  priority?: number;
  tags?: unknown;
  start_at?: string | null;
  due_at?: string | null;
};

function parseDate(v: string | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { ids?: unknown; patch?: unknown };

    // --- ids 検証 ---
    if (!Array.isArray(body.ids)) {
      return NextResponse.json({ error: "ids is required" }, { status: 400 });
    }
    if (!body.ids.every((v) => Number.isInteger(v) && (v as number) > 0)) {
      return NextResponse.json({ error: "ids must be positive integers" }, { status: 400 });
    }
    const ids = Array.from(new Set(body.ids as number[]));
    if (ids.length === 0) {
      return NextResponse.json({ error: "ids must be a non-empty array" }, { status: 400 });
    }
    if (ids.length > MAX_IDS) {
      return NextResponse.json({ error: `too many ids (max ${MAX_IDS})` }, { status: 400 });
    }

    // --- patch 検証 (含まれるキーのみ採用) ---
    const rawPatch = body.patch ?? {};
    if (typeof rawPatch !== "object" || rawPatch === null || Array.isArray(rawPatch)) {
      return NextResponse.json({ error: "invalid patch" }, { status: 400 });
    }
    const p = rawPatch as BodyPatch;
    const patch: BatchTodoPatch = {};

    if ("project" in p) {
      if (!(p.project === null || typeof p.project === "string")) {
        return NextResponse.json({ error: "invalid project" }, { status: 400 });
      }
      patch.projectName = p.project;
    }
    if (p.state !== undefined) {
      if (!STATES.includes(p.state as (typeof STATES)[number])) {
        return NextResponse.json({ error: "invalid state" }, { status: 400 });
      }
      patch.state = p.state as BatchTodoPatch["state"];
    }
    if (p.priority !== undefined) {
      if (![1, 2, 3].includes(p.priority)) {
        return NextResponse.json({ error: "invalid priority" }, { status: 400 });
      }
      patch.priority = p.priority as 1 | 2 | 3;
    }
    if (p.tags !== undefined) {
      if (!Array.isArray(p.tags) || !p.tags.every((t) => typeof t === "string")) {
        return NextResponse.json({ error: "invalid tags" }, { status: 400 });
      }
      patch.tags = p.tags as string[];
    }
    if ("start_at" in p) {
      const d = parseDate(p.start_at);
      if (d === undefined) {
        return NextResponse.json({ error: "invalid start_at" }, { status: 400 });
      }
      patch.startAt = d;
    }
    if ("due_at" in p) {
      const d = parseDate(p.due_at);
      if (d === undefined) {
        return NextResponse.json({ error: "invalid due_at" }, { status: 400 });
      }
      patch.dueAt = d;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: "patch must have at least one field" }, { status: 400 });
    }

    const result = await batchUpdateTodos(ids, patch);
    return NextResponse.json({ ok: true, ...result });
  } catch (e) {
    return clientError(req, e, { context: "todos/batch", message: "TODO の一括更新に失敗しました" });
  }
}
