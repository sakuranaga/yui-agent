/**
 * POST /api/mail/polish
 *   body: { text: string }
 *   → { polished: string }
 *   校正結果を返すだけ (置換は UI 側で決定)。
 */
import { NextResponse, type NextRequest } from "next/server";
import { polishMailBody } from "@/lib/mail-draft";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { text?: string };
    if (typeof body.text !== "string") {
      return NextResponse.json({ error: "text required" }, { status: 400 });
    }
    const polished = await polishMailBody(body.text);
    return NextResponse.json({ polished });
  } catch (e) {
    return clientError(req, e, { context: "mail/polish", message: "本文校正に失敗しました" });
  }
}
