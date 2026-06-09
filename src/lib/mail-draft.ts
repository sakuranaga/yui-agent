/**
 * メール下書き支援 (Sonnet 経由)。
 *
 * - polishMailBody:   既存本文を「丁寧なビジネス文体」に整形 (左右差分用)
 * - generateReply:    元メールへの返信ドラフトを intent プリセット (了承/断り/保留/単純確認) で生成
 *
 * 設計: docs/mail-system.md §6.2.5
 */
import Anthropic from "@anthropic-ai/sdk";
import { callLlm } from "@/lib/llm";

export type ReplyIntent = "agree" | "decline" | "hold" | "ack";

const INTENT_LABEL: Record<ReplyIntent, string> = {
  agree: "了承",
  decline: "丁重にお断り",
  hold: "保留 (検討してから返答する旨)",
  ack: "単純確認 (受領のみ伝える)",
};

/** 既存本文を丁寧文体に整形。元と差し替え候補を返すだけで、置換は UI で判定。 */
export async function polishMailBody(body: string): Promise<string> {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const system = `あなたはご主人様のメール校正アシスタントです。
入力された本文をビジネスメールとして丁寧で適切な表現に整えてください。

ルール:
- 元の意図と情報は保持する (新情報の追加・削除はしない)
- 敬語 / ですます調で統一
- 件名や宛名 / 自分の署名は付けない (本文のみ)
- 「お世話になっております」「よろしくお願いいたします」等の定型はあってよい
- マークダウン / コードブロック / 装飾は使わない
- 出力は校正後の本文のみ (説明文不要)`;

  const res = await callLlm("main", {
    maxTokens: 1500,
    system,
    messages: [{ role: "user", content: trimmed }],
  });
  return collectText(res).trim();
}

export type GenerateReplyInput = {
  intent: ReplyIntent;
  /** 元メール (本文 + メタ) */
  original: {
    fromName: string | null;
    fromEmail: string;
    subject: string | null;
    body: string;
  };
  /** ユーザが自由記述で添えたい補足 (空でも可) */
  hint?: string;
};

export async function generateReply(input: GenerateReplyInput): Promise<string> {
  const system = `あなたはご主人様のメール秘書です。
受信したメールへの返信本文をドラフトしてください。

ルール:
- 丁寧で適切なビジネスメール調 (ですます調 / 敬語)
- 元メールの内容を踏まえる
- 自分の署名 / 宛名行 (Dear ... 等) / 件名は付けない (本文のみ)
- 「お世話になっております」等の定型挨拶を冒頭に添えてよい
- 「よろしくお願いいたします」等で締めてよい
- マークダウン / コードブロック装飾は使わない
- 出力は本文のみ (説明文や前置き不要)`;

  const userMsg = [
    `## 返信スタンス`,
    INTENT_LABEL[input.intent],
    input.hint ? `\n## ご主人様からの補足\n${input.hint}` : "",
    ``,
    `## 元メール`,
    `From: ${input.original.fromName ?? input.original.fromEmail}`,
    `Subject: ${input.original.subject ?? "(件名なし)"}`,
    ``,
    input.original.body.slice(0, 4000),
  ]
    .filter(Boolean)
    .join("\n");

  const res = await callLlm("main", {
    maxTokens: 1500,
    system,
    messages: [{ role: "user", content: userMsg }],
  });
  return collectText(res).trim();
}

function collectText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
