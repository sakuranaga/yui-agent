/**
 * GET /api/setup/status
 *
 * 初回セットアップが完了しているかを返す。
 *
 * 「最低限動くために必要なもの」=
 *   - いずれかの provider に API key が登録されている
 *   - その provider 用の main model が登録されている
 *   - Embeddings URL + model + dimensions が登録されている (= memory 機能の前提)
 *
 * 1 つでも欠けると `/` から `/setup` にリダイレクトされる。
 * `/setup` 自身からはリダイレクトしない (= 再設定で上書きする運用)。
 */
import { NextResponse } from "next/server";
import { getAiSetting, getEmbedConfig } from "@/lib/ai-settings";

export const dynamic = "force-dynamic";

export async function GET() {
  const [anthropicKey, openaiKey, geminiKey, grokKey, mainModel] =
    await Promise.all([
      getAiSetting("anthropic_api_key"),
      getAiSetting("openai_api_key"),
      getAiSetting("gemini_api_key"),
      getAiSetting("grok_api_key"),
      getAiSetting("anthropic_main_model"),
    ]);

  const hasProviderKey = Boolean(
    anthropicKey || openaiKey || geminiKey || grokKey
  );
  // anthropic_main_model 列名は legacy (= 全 provider で main model を保持する 1 列)。
  // DB に保存があり、かつデフォルト値 "claude-sonnet-4-6" 以外なら「明示的に設定済」と
  // 判定するか? → デフォルトでも valid な model なので、null/空でなければ OK とする。
  const hasMainModel = Boolean(mainModel && mainModel.length > 0);

  const embed = await getEmbedConfig();
  const hasEmbeddings = Boolean(
    embed.url && embed.model && embed.dimensions && embed.dimensions > 0
  );

  const configured = hasProviderKey && hasMainModel && hasEmbeddings;

  return NextResponse.json({
    configured,
    hasProviderKey,
    hasMainModel,
    hasEmbeddings,
  });
}
