/**
 * GET /api/ai-settings/models
 *
 * 登録済みの API キーをもとに、全 provider の利用可能な model 一覧を返す。
 * 各 provider の `/v1/models` 系を直叩きして 1h Valkey にキャッシュ。
 *
 * 戻り値:
 *   { models: LlmModel[], providers: { anthropic: boolean, ... } }
 *
 *   providers は「API キーが登録されていて、かつ model 取得に成功したか」を示す。
 *   UI 側は providers から「キー登録済みだが model 取得に失敗した」を判定して
 *   警告を出せる (要求 = キーあり、結果 = 該当 provider の model が 0 件)。
 *
 * クエリパラメータ:
 *   ?refresh=1  cache を無視して再取得 (例: API キー更新直後)
 */
import { NextResponse, type NextRequest } from "next/server";
import { getAiSetting } from "@/lib/ai-settings";
import {
  listModelsForProvider,
  invalidateModelsCache,
  type LlmModel,
  type ProviderId,
} from "@/lib/llm-models";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const refresh = req.nextUrl.searchParams.get("refresh") === "1";

  const [anthropicKey, openaiKey, geminiKey, grokKey] = await Promise.all([
    getAiSetting("anthropic_api_key"),
    getAiSetting("openai_api_key"),
    getAiSetting("gemini_api_key"),
    getAiSetting("grok_api_key"),
  ]);

  if (refresh) {
    await invalidateModelsCache();
  }

  const keyMap: Record<ProviderId, string | null> = {
    anthropic: anthropicKey,
    openai: openaiKey,
    gemini: geminiKey,
    grok: grokKey,
  };

  const providerIds: ProviderId[] = ["anthropic", "openai", "gemini", "grok"];
  const results = await Promise.all(
    providerIds.map((p) => listModelsForProvider(p, keyMap[p]))
  );

  const models: LlmModel[] = results.flat();
  const providers: Record<ProviderId, { hasKey: boolean; modelCount: number }> = {
    anthropic: { hasKey: !!anthropicKey, modelCount: results[0].length },
    openai:    { hasKey: !!openaiKey,    modelCount: results[1].length },
    gemini:    { hasKey: !!geminiKey,    modelCount: results[2].length },
    grok:      { hasKey: !!grokKey,      modelCount: results[3].length },
  };

  return NextResponse.json({ models, providers });
}
