import { NextResponse, type NextRequest } from "next/server";
import { markSeen } from "@/lib/notifications";
import { clientError } from "@/lib/api-error";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  const numId = Number(id);
  if (!Number.isFinite(numId)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }
  try {
    await markSeen(numId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "notifications/[id]/seen", message: "通知の既読化に失敗しました" });
  }
}
