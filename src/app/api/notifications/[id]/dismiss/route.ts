import { NextResponse, type NextRequest } from "next/server";
import { markDismissed } from "@/lib/notifications";
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
    await markDismissed(numId);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "notifications/[id]/dismiss", message: "通知の dismiss に失敗しました" });
  }
}
