/**
 * GET  /api/mail/curation-settings
 * PUT  /api/mail/curation-settings        partial update
 * POST /api/mail/curation-settings/vip    body: { email, action: "add"|"remove" }
 * POST /api/mail/curation-settings/block  body: { email, action: "add"|"remove" }
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  getMailCurationSettings,
  updateMailCurationSettings,
} from "@/lib/mail-curation-settings";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET() {
  const s = await getMailCurationSettings();
  return NextResponse.json(s);
}

export async function PUT(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      interestProfile?: string;
      scoreThreshold?: number;
      vipAddresses?: string[];
      blockedAddresses?: string[];
    };
    const patch: Parameters<typeof updateMailCurationSettings>[0] = {};
    if (typeof body.interestProfile === "string") {
      patch.interestProfile = body.interestProfile.slice(0, 4000);
    }
    if (typeof body.scoreThreshold === "number") {
      patch.scoreThreshold = Math.max(0, Math.min(1, body.scoreThreshold));
    }
    if (Array.isArray(body.vipAddresses)) {
      patch.vipAddresses = body.vipAddresses
        .filter((s) => typeof s === "string")
        .map((s) => s.toLowerCase().trim())
        .filter((s) => s.length > 0);
    }
    if (Array.isArray(body.blockedAddresses)) {
      patch.blockedAddresses = body.blockedAddresses
        .filter((s) => typeof s === "string")
        .map((s) => s.toLowerCase().trim())
        .filter((s) => s.length > 0);
    }
    await updateMailCurationSettings(patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { status: 400, context: "mail/curation-settings", message: "キュレーション設定の更新に失敗しました" });
  }
}
