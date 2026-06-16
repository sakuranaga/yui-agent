/**
 * POST /api/model-registry/<id>/test
 *
 * 登録済みモデル entry の能力テストを実行する (#206 M2)。
 *   ① 到達性 (ping) ② tool-use 対応 (echo を tool_choice で強制 probe)。
 * 結果を entry.capabilities に保存して返す。
 *
 * 設計: docs/model-config-overhaul.md §2.3 / §6
 *   - テストは「登録済みエントリの base_url」だけを叩く (任意 URL を都度叩かない = SSRF 配慮)。
 *   - cookie 認証 (proxy.ts、PUBLIC_PATHS 外) が前提。
 */
import { NextResponse, type NextRequest } from "next/server";
import { getModel } from "@/lib/model-registry";
import { testAndSaveCapabilities } from "@/lib/model-call";
import { clientError } from "@/lib/api-error";

export const dynamic = "force-dynamic";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const entry = await getModel(id);
    if (!entry) {
      return NextResponse.json({ error: "model not found" }, { status: 404 });
    }
    const capabilities = await testAndSaveCapabilities(entry);
    return NextResponse.json({ ok: true, capabilities });
  } catch (e) {
    // testModelCapabilities は probe 自体の error を categorize して capabilities.lastError に
    // 丸めるので、ここに来るのは params 展開 / getModel / DB 保存失敗等の想定外のみ。
    return clientError(_req, e, {
      context: "model-registry/test",
      message: "能力テストに失敗しました",
    });
  }
}
