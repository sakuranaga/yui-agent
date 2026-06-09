/**
 * 朝のブリーフ markdown を、Yui のキャラ口調で「おはようございます」付きの
 * セリフに変換する。saveNotification の speakText に入れて、Web TTS と
 * Discord の両方に同じ文面で届ける。
 *
 * 設計: docs/notification-system.md (朝のブリーフ統一発話)
 */
import Anthropic from "@anthropic-ai/sdk";
import { callLlm } from "@/lib/llm";
import { loadPersona } from "@/lib/persona";
import { buildYuiSystemPrompt } from "@/app/api/chat/yui-prompt";

const MORNING_GUIDANCE = `## このターンの役割
ご主人様への朝の挨拶 + 今日のブリーフィングを 1 メッセージで届けてください。

## 出力フォーマット
全体で 200 字以内、3〜5 文:
- まず朝の挨拶 (例: "ご主人様、おはようございます")
- 今日の予定 / 期限近い todos / 注目ニュースのうち、特に伝えるべき要点を
  自然な口調でまとめる (列挙ではなく会話的に)
- 最後に軽く一言ねぎらいや励まし (任意)

リンクや細かい時刻は読みづらいので、要点だけ。詳細はお便りモーダルで見られます。
キャラとしてのセリフだけを返してください。`;

export async function generateMorningSpeech(briefMarkdown: string): Promise<string> {
  const persona = await loadPersona();
  const basePrompt = buildYuiSystemPrompt(persona);
  const system = `${basePrompt}\n\n${MORNING_GUIDANCE}`;

  const userMsg = [
    `## 今朝のブリーフィング素材`,
    briefMarkdown.slice(0, 4000),
  ].join("\n");

  const response = await callLlm("morning_speak", {
    maxTokens: 500,
    system,
    messages: [{ role: "user", content: userMsg }],
  });

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  if (!text) {
    return "ご主人様、おはようございます。今朝のブリーフィングをお便りに置いておきますね。";
  }
  return text;
}
