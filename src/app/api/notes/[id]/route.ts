/**
 * GET    /api/notes/[id]   単体取得 (= 本文込み)
 * PATCH  /api/notes/[id]   編集 { title?, body_md?, pinned?, archived? }
 * DELETE /api/notes/[id]   物理削除 (= note_chunks は FK CASCADE)
 */
import { NextResponse, type NextRequest } from "next/server";
import { deleteNote, getNote, updateNote } from "@/lib/notes";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

function parseId(idStr: string): number | null {
  const id = Number(idStr);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });
    const note = await getNote(id);
    if (!note) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ note });
  } catch (e) {
    return clientError(req, e, { context: "notes/[id]", message: "ノートの取得に失敗しました" });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });
    const body = (await req.json()) as {
      title?: string;
      body_md?: string;
      pinned?: boolean;
      archived?: boolean;
    };
    const note = await updateNote(id, {
      title: body.title,
      bodyMd: body.body_md,
      pinned: body.pinned,
      archived: body.archived,
    });
    if (!note) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ note });
  } catch (e) {
    return clientError(req, e, { context: "notes/[id]", message: "ノートの更新に失敗しました" });
  }
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const id = parseId((await params).id);
    if (id === null) return NextResponse.json({ error: "invalid id" }, { status: 400 });
    const ok = await deleteNote(id);
    if (!ok) return NextResponse.json({ error: "not found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "notes/[id]", message: "ノートの削除に失敗しました" });
  }
}
