import type Anthropic from "@anthropic-ai/sdk";
import { buildYuiSystemPrompt } from "@/app/api/chat/yui-prompt";
import { loadPersona } from "@/lib/persona";
import { callLlm } from "@/lib/llm";
import { sanitizeAssistantText } from "@/lib/response-sanitizer";
import type { UnifiedToolOutcome } from "@/lib/tools/outcome";

function textOfMessage(m: Anthropic.Message): string {
  return m.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
}

export function buildPendingJobAck(
  jobs: Array<{ jobId: number; specialist: string }>,
  userText: string,
): string {
  const specialists = new Set(jobs.map((j) => j.specialist));
  if (specialists.has("schedule") || specialists.has("ask_schedule_specialist")) {
    if (/明日.*(予定|スケジュール|カレンダー)|(予定|スケジュール|カレンダー).*明日/.test(userText)) {
      return "あら、明日のご予定ですね。お調べしますので、少しお待ちください。";
    }
    return "ご予定をお調べしますので、少しお待ちください。";
  }
  if (specialists.has("mail") || specialists.has("ask_mail_specialist")) return "メールを確認しますので、少しお待ちください。";
  if (specialists.has("research") || specialists.has("ask_research_specialist")) return "お調べしますので、少しお待ちください。";
  return "確認しますので、少しお待ちください。";
}

export async function generateDirectToolReply(args: {
  currentUserMsg: string;
  outcomes: UnifiedToolOutcome[];
}): Promise<string> {
  const persona = await loadPersona();
  const personaPrompt = buildYuiSystemPrompt(persona);
  const payload = {
    userMessage: args.currentUserMsg,
    outcomes: args.outcomes.map((o) => ({
      toolName: o.toolName,
      state: o.state,
      responsePolicy: o.responsePolicy,
      userVisible: o.userVisible,
      input: o.input,
      result: o.result,
      skipReason: o.skipReason ?? null,
      error: o.error ?? null,
    })),
  };
  const system = [
    personaPrompt,
    "",
    "あなたは上記ペルソナとして、アプリ内ツールの実行完了を1文だけ自然に報告します。",
    "通常チャットの履歴・記憶・環境情報は一切使えません。入力 JSON だけが事実です。",
    "入力 JSON に無いタイトル、日時、場所、件数、結果を絶対に補完しないでください。",
    "toolName や JSON や内部処理名は出さず、ユーザーに見える自然な言葉だけで返してください。",
    "口調はペルソナに合わせてください。ただし簡潔に、1文だけ。",
  ].join("\n");
  const user = [
    "この JSON だけを材料に、ご主人様への完了報告を1文で作ってください。",
    "",
    JSON.stringify(payload, null, 2).slice(0, 6000),
  ].join("\n");
  const resp = await callLlm("voice", {
    system,
    messages: [{ role: "user", content: user }],
    maxTokens: 160,
    temperature: 0.3,
  });
  return sanitizeAssistantText(textOfMessage(resp));
}
