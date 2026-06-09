/**
 * GET /api/notifications?session=<id>&unread_only=1&include_dismissed=&before=<id>&limit=50
 *   通知一覧。トースト初回ロードと LogModal「お便り」タブの両方から使う。
 */
import { NextResponse, type NextRequest } from "next/server";
import { listNotifications } from "@/lib/notifications";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  const sessionId = req.nextUrl.searchParams.get("session")?.trim();
  if (!sessionId) {
    return NextResponse.json({ error: "session required" }, { status: 400 });
  }
  const unreadOnly = req.nextUrl.searchParams.get("unread_only") === "1";
  const includeDismissed = req.nextUrl.searchParams.get("include_dismissed") === "1";
  const beforeRaw = parseInt(req.nextUrl.searchParams.get("before") ?? "", 10);
  const before = Number.isFinite(beforeRaw) && beforeRaw > 0 ? beforeRaw : undefined;
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50;
  try {
    const rows = await listNotifications({
      sessionId,
      unreadOnly,
      includeDismissed,
      before,
      limit,
    });
    return NextResponse.json({
      notifications: rows.map((n) => ({
        id: Number(n.id),
        kind: n.kind,
        importance: n.importance as "high" | "normal" | "low" | "silent",
        title: n.title,
        preview: n.preview ?? "",
        bodyMd: n.bodyMd ?? null,
        createdAt: n.createdAt.toISOString(),
        seenAt: n.seenAt?.toISOString() ?? null,
        dismissedAt: n.dismissedAt?.toISOString() ?? null,
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "notifications", message: "通知一覧の取得に失敗しました" });
  }
}
