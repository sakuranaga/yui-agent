/**
 * POST /api/notifications/<id>/replay
 *   1) notification を seen + dismissed にマーク
 *   2) body_md を ReportPanel に push (report_update event)
 *
 * 「ご主人様が開いた」のは Yui の能動アクションではないので、TTS の口頭ack は出さない。
 * クライアント側で開いたタイミングに軽い効果音を鳴らす想定。
 *
 * 設計: docs/notification-system.md §7
 */
import { NextResponse, type NextRequest } from "next/server";
import { getNotification, markSeen, markDismissed } from "@/lib/notifications";
import { pushToSession } from "@/lib/jobs/events";
import { clientError } from "@/lib/api-error";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    const n = await getNotification(numId);
    if (!n) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    // seen + dismissed を両方打つ (一覧から消えるが履歴には残る)
    await markSeen(numId);
    await markDismissed(numId);

    // ReportPanel に push。bodyMd が無くても preview / payload からフォールバック生成。
    const md =
      n.bodyMd && n.bodyMd.trim().length > 0
        ? n.bodyMd
        : `# ${n.title}\n\n${n.preview ?? ""}`;
    pushToSession(n.sessionId, {
      type: "report_update",
      jobId: Date.now(),
      title: n.title,
      markdown: md,
    });

    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "notifications/[id]/replay", message: "通知の再生に失敗しました" });
  }
}
