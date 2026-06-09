/**
 * GET /api/settings/integrations
 *   全 integration key の現状 (secret はマスク済)
 *
 * PUT /api/settings/integrations
 *   body: { key: IntegrationKey, value: string }
 *   value="" で削除、マスク値 ("***" 等) は更新せず既存維持
 */
import { NextResponse, type NextRequest } from "next/server";
import { listSettings, setSetting, type IntegrationKey } from "@/lib/integration-settings";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function GET() {
  const items = await listSettings();
  return NextResponse.json({ items });
}

export async function PUT(req: NextRequest) {
  let body: { key?: string; value?: string };
  try {
    body = (await req.json()) as { key?: string; value?: string };
  } catch {
    return NextResponse.json({ error: "invalid json" }, { status: 400 });
  }
  if (!body.key || typeof body.value !== "string") {
    return NextResponse.json({ error: "key + value required" }, { status: 400 });
  }
  const allowed: IntegrationKey[] = [
    "google_maps_api_key",
    "spotify_client_id",
    "spotify_client_secret",
  ];
  if (!allowed.includes(body.key as IntegrationKey)) {
    return NextResponse.json({ error: `unknown key: ${body.key}` }, { status: 400 });
  }
  try {
    await setSetting(body.key as IntegrationKey, body.value);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return clientError(req, e, { context: "settings/integrations", message: "連携設定の更新に失敗しました" });
  }
}
