/**
 * キュレーション通過したニュース 1 件を、Yui のキャラ口調で読み上げセリフに変換する。
 *
 * - Sonnet 呼び出し
 * - persona は loadPersona() + buildYuiSystemPrompt() で標準を流用
 * - news 専用ガイダンスを追加
 * - 120 字程度の短いセリフを返す
 *
 * 設計: docs/news-curation.md §4
 */
import Anthropic from "@anthropic-ai/sdk";
import { callLlm } from "@/lib/llm";
import { loadPersona } from "@/lib/persona";
import { buildYuiSystemPrompt } from "@/app/api/chat/yui-prompt";

export type NewsForSpeech = {
  title: string;
  sourceName: string;
  summary: string | null;
  link: string | null;
  score: number;
  scoreReason: string | null;
};

const NEWS_GUIDANCE = `## このターンの役割
ニュース記事を 1 件、ご主人様に紹介してください。

## 出力フォーマット
1〜3 文 (合計 120 字以内) で:
- 「ご主人様、面白いニュースが届いてますよ」のような呼びかけから始めて
- 内容の要点 (1 文)
- ゆいとしての軽い感想 (1 文、任意)

リンクや URL は読み上げず、お便りモーダルで見てもらうので含めないでください。
キャラとしてのセリフだけを返してください。`;

export async function generateNewsSpeech(news: NewsForSpeech): Promise<string> {
  const persona = await loadPersona();
  const basePrompt = buildYuiSystemPrompt(persona);
  const system = `${basePrompt}\n\n${NEWS_GUIDANCE}`;

  const userMsg = [
    `## ニュース`,
    `タイトル: ${news.title}`,
    `ソース: ${news.sourceName}`,
    news.summary ? `要約: ${news.summary.slice(0, 600)}` : "(要約なし)",
    news.scoreReason ? `(興味マッチの根拠: ${news.scoreReason})` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const response = await callLlm("news_speak", {
    maxTokens: 300,
    system,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  // 万一空なら最低限のフォールバック (お便りの存在自体は通知する)
  if (!text) {
    return `ご主人様、新しいニュースが届きました。${news.title}についてです。`;
  }
  return text;
}
