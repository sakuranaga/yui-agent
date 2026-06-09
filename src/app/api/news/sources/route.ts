/**
 * GET  /api/news/sources       — 全 source 一覧
 * POST /api/news/sources       — body: {name, url}  → 追加
 */
import { NextResponse, type NextRequest } from "next/server";
import { addSource, listSources } from "@/lib/news";
import { validatePublicUrl } from "@/lib/url-validate";

export async function GET() {
  try {
    const items = await listSources();
    return NextResponse.json({
      count: items.length,
      sources: items.map((s) => ({
        id: s.id,
        name: s.name,
        url: s.url,
        enabled: s.enabled,
        created_at: s.createdAt.toISOString(),
      })),
    });
  } catch (e) {
    const { clientError } = await import("@/lib/api-error");
    return clientError(undefined, e, { context: "news/sources" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { name?: string; url?: string };
    if (!body.name || !body.url) {
      return NextResponse.json({ error: "name and url required" }, { status: 400 });
    }
    // SSRF 防護: 背景 cron が後で fetch するので、登録時点で内部 IP/ホストを拒否
    const blockReason = await validatePublicUrl(body.url);
    if (blockReason) {
      return NextResponse.json(
        { error: `URL refused: ${blockReason}` },
        { status: 400 }
      );
    }
    const s = await addSource({ name: body.name, url: body.url });
    return NextResponse.json({
      ok: true,
      source: { id: s.id, name: s.name, url: s.url, enabled: s.enabled },
    });
  } catch (e) {
    const { clientError } = await import("@/lib/api-error");
    return clientError(undefined, e, { context: "news/sources" });
  }
}
