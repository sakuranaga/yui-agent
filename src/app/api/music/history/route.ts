/**
 * GET /api/music/history?limit=30
 *
 * 永続化された曲レベル履歴 (新しい順、id 重複除去済)。
 * container_* (playlist/album 出処) を含む。
 */
import { NextResponse, type NextRequest } from "next/server";
import { loadTrackHistoryFromDb } from "@/lib/music-commands";
import { clientError } from "@/lib/api-error";

export async function GET(req: NextRequest) {
  const limitRaw = parseInt(req.nextUrl.searchParams.get("limit") ?? "", 10);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 100) : 30;
  try {
    const list = await loadTrackHistoryFromDb(limit);
    return NextResponse.json({
      count: list.length,
      history: list.map((e) => ({
        timestamp: e.timestamp,
        track: e.track,
        container: e.containerKind
          ? {
              kind: e.containerKind,
              id: e.containerId,
              name: e.containerName,
            }
          : null,
      })),
    });
  } catch (e) {
    return clientError(req, e, { context: "music/history", message: "再生履歴の取得に失敗しました" });
  }
}
