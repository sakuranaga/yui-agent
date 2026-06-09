/**
 * DELETE /api/news/sources/[id]            — source 削除 (関連 articles も CASCADE で消える)
 * PATCH  /api/news/sources/[id]  body: {enabled}  — 有効無効切替
 */
import { NextResponse, type NextRequest } from "next/server";
import { removeSource, setSourceEnabled, updateSource } from "@/lib/news";
import { validatePublicUrl } from "@/lib/url-validate";

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    await removeSource(numId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    const { clientError } = await import("@/lib/api-error");
    return clientError(undefined, e, { context: "news/sources/[id]" });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = parseInt(id, 10);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const body = (await req.json()) as {
      enabled?: boolean;
      name?: string;
      url?: string;
    };
    // enabled トグルだけのケース (互換維持)
    if (
      typeof body.enabled === "boolean" &&
      body.name === undefined &&
      body.url === undefined
    ) {
      const s = await setSourceEnabled(numId, body.enabled);
      if (!s) return NextResponse.json({ error: "source not found" }, { status: 404 });
      return NextResponse.json({
        ok: true,
        source: { id: s.id, name: s.name, url: s.url, enabled: s.enabled },
      });
    }
    // name / url 更新 (enabled も同時更新可)
    if (body.url !== undefined) {
      // Stored SSRF 対策: POST と同じ検証を PATCH でも実行 (= 既存 source の url を
      // 内部 IP に更新する攻撃を防ぐ)
      const blockReason = await validatePublicUrl(body.url);
      if (blockReason) {
        return NextResponse.json(
          { error: `URL refused: ${blockReason}` },
          { status: 400 }
        );
      }
    }
    if (body.name !== undefined && body.name.trim().length === 0) {
      return NextResponse.json({ error: "name must not be empty" }, { status: 400 });
    }
    const s = await updateSource(numId, { name: body.name, url: body.url });
    if (!s) return NextResponse.json({ error: "source not found" }, { status: 404 });
    if (typeof body.enabled === "boolean") {
      const s2 = await setSourceEnabled(numId, body.enabled);
      return NextResponse.json({
        ok: true,
        source: s2 && {
          id: s2.id,
          name: s2.name,
          url: s2.url,
          enabled: s2.enabled,
        },
      });
    }
    return NextResponse.json({
      ok: true,
      source: { id: s.id, name: s.name, url: s.url, enabled: s.enabled },
    });
  } catch (e) {
    const { clientError } = await import("@/lib/api-error");
    return clientError(undefined, e, { context: "news/sources/[id]" });
  }
}
