/**
 * GET  /api/model-registry  → 登録モデル一覧 (#206 M4)
 * POST /api/model-registry  → モデル追加
 *
 * cookie 認証 (proxy.ts、PUBLIC_PATHS 外) 前提。
 * 設計: docs/model-config-overhaul.md §8.6.1
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  listModels,
  createModel,
  sanitizeLocalBaseUrl,
  type ModelProvider,
} from "@/lib/model-registry";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

const PROVIDERS: ModelProvider[] = ["anthropic", "openai", "gemini", "grok", "local_openai"];

export async function GET() {
  try {
    const entries = await listModels();
    return NextResponse.json({ entries });
  } catch (e) {
    return clientError(undefined, e, { context: "model-registry/list", message: "モデル一覧の取得に失敗しました" });
  }
}

export async function POST(req: NextRequest) {
  let body: { label?: string; provider?: string; modelId?: string; baseUrl?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "JSON が不正です" }, { status: 400 });
  }

  const label = (body.label ?? "").trim();
  const provider = body.provider as ModelProvider;
  const modelId = (body.modelId ?? "").trim();

  if (!label) return NextResponse.json({ error: "ラベルは必須です" }, { status: 400 });
  if (!PROVIDERS.includes(provider)) return NextResponse.json({ error: "provider が不正です" }, { status: 400 });
  if (!modelId) return NextResponse.json({ error: "モデル ID は必須です" }, { status: 400 });

  // local_openai は base_url 必須 + 軽量検証。hosted は base_url 不要。
  let baseUrl: string | null = null;
  if (provider === "local_openai") {
    if (!body.baseUrl || !body.baseUrl.trim()) {
      return NextResponse.json({ error: "ローカルモデルは base_url が必須です" }, { status: 400 });
    }
    const v = sanitizeLocalBaseUrl(body.baseUrl);
    if (!v.ok) return NextResponse.json({ error: v.error }, { status: 400 });
    baseUrl = v.value;
  }

  try {
    const entry = await createModel({
      label,
      provider,
      modelId,
      baseUrl,
      apiKeyRef: provider === "local_openai" ? null : provider,
    });
    return NextResponse.json({ entry }, { status: 201 });
  } catch (e) {
    return clientError(req, e, { context: "model-registry/create", message: "モデルの追加に失敗しました" });
  }
}
