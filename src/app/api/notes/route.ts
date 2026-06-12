/**
 * GET  /api/notes?q=&source=&archived=&limit=&offset=
 *   ノート一覧 / 検索 (docs/yui-notes.md §4)。
 *     - q 空        → browse モード (= 新着順、offset ページング、total=全件)
 *     - q あり      → search モード (= lexical FTS ∪ semantic 融合、候補上限 50)
 *   返却: { mode, total, ... , notes }
 * POST /api/notes
 *   新規ノート作成。body: { title?, body_md, source?, source_meta? }
 */
import { NextResponse, type NextRequest } from "next/server";
import { createNote, isValidSource, queryNotes } from "@/lib/notes";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const q = sp.get("q") ?? undefined;

    const source = sp.get("source") ?? undefined;
    if (source && !isValidSource(source)) {
      return NextResponse.json({ error: `invalid source: ${source}` }, { status: 400 });
    }

    // limit/offset は queryNotes 側で NaN/範囲外をクランプするので素直に数値化のみ
    const limitRaw = sp.get("limit");
    const offsetRaw = sp.get("offset");
    const limit = limitRaw !== null ? Number(limitRaw) : undefined;
    const offset = offsetRaw !== null ? Number(offsetRaw) : undefined;
    const includeArchived = sp.get("archived") === "1";

    const result = await queryNotes({ query: q, source, includeArchived, limit, offset });
    return NextResponse.json(result);
  } catch (e) {
    return clientError(req, e, { context: "notes", message: "ノートの取得に失敗しました" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      title?: string;
      body_md?: string;
      source?: string;
      source_meta?: Record<string, unknown>;
    };
    const bodyMd = body.body_md?.trim();
    if (!bodyMd) {
      return NextResponse.json({ error: "body_md required" }, { status: 400 });
    }
    if (body.source && !isValidSource(body.source)) {
      return NextResponse.json({ error: `invalid source: ${body.source}` }, { status: 400 });
    }
    const note = await createNote({
      title: body.title,
      bodyMd,
      source: body.source,
      sourceMeta: body.source_meta,
    });
    return NextResponse.json({ note });
  } catch (e) {
    return clientError(req, e, { context: "notes", message: "ノートの作成に失敗しました" });
  }
}
