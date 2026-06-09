/**
 * Yui (Sonnet) が specialist を dispatch しようとした時、その呼び出しが
 * 本当に必要かを Haiku に再検証させる軽量 judge。
 *
 * 背景:
 *   Sonnet は env block (流れている曲・天気・タイマー等) を持っているが、
 *   時々それで答え切れる質問でも specialist を呼んでしまう。結果として
 *   「Yui の直答 + 数秒後に specialist 経由の voice 完了応答」の二重応答が
 *   発生する。Haiku の判定 (1-2s, ~$0.001/call) を間に挟むことで、不要な
 *   dispatch を物理的に skip する。
 *
 * 入力:
 *   - ユーザーの今回の発話
 *   - Yui が直前にユーザーへ返した text (直答 or ack)
 *   - 呼ぼうとしている specialist と query
 *   - 現在の環境情報 (env block の文字列丸ごと)
 *
 * 出力:
 *   - "dispatch": そのまま実行
 *   - "skip": 不要なので Yui に「環境ブロックで答えてください」と返す
 *
 * 失敗時は安全側 (= dispatch する) に倒す。Yui の決定を尊重する方が
 * "skipped すべきだったのに呼んじゃった" よりも実害が少ない。
 */
import Anthropic from "@anthropic-ai/sdk";
import { callLlm } from "@/lib/llm";

const JUDGE_MAX_TOKENS = 200;

export type JudgeDecision = {
  action: "dispatch" | "skip";
  reason: string;
};

export type JudgeInput = {
  userMessage: string;
  yuiAckText: string;
  toolName: string;
  toolQuery: string;
  envBlock: string;
};

const SYSTEM_PROMPT = `あなたは「Yui (主秘書 AI) の dispatch 判定を行う軽量ジャッジ」です。

Yui は今、specialist (バックグラウンドの調査員) を呼ぼうとしています。
あなたは以下の情報を元に、その呼び出しが本当に必要かを判定します。

判定基準:
- env block (時刻・天気・流れている曲・タイマー等) と Yui の直答テキストだけで、
  ユーザーの質問に十分答えられるなら → "skip" (呼ぶ必要なし)
- env block に無い深い情報 (人物経歴、外部 DB の状態、メール内容、タスク一覧、Web 上の情報等) が
  必要、または外部システム操作 (再生開始/停止、予定追加、メール送信等) が必要なら → "dispatch"
- 操作系 → 原則 "dispatch"。ただし音楽 transport (「止めて」「次の曲」「前の曲」「音量」「いまの曲」)
  は Yui main の direct tool (music_pause / music_next / music_prev / music_volume / music_now_playing) で
  処理されるべきで、specialist 経由は本来不要。万が一 ask_music_specialist が呼ばれてしまった場合は
  "skip" を返して二重実行を防ぐ。新規選曲 (= 「ジャズかけて」「<曲名> 流して」) は specialist 必須で "dispatch"。
- 単純な情報質問 (例: 「いま流れてる曲のタイトル?」「現在時刻は?」「天気は?」) で env block に
  情報があれば "skip"
- 判断に迷ったら "dispatch" (= Yui の決定を尊重、誤 skip の方が害が大きい)

出力は JSON 1 行のみ。Markdown コードフェンス禁止。
{"action": "dispatch" | "skip", "reason": "30 字以内の判定理由"}`;

export async function judgeDispatch(input: JudgeInput): Promise<JudgeDecision> {
  const userContent = [
    "【ユーザーの今回の発話】",
    input.userMessage,
    "",
    "【Yui が直前にユーザーへ返した text (直答 or 動作予告)】",
    input.yuiAckText || "(なし)",
    "",
    "【Yui が呼ぼうとしている tool】",
    `${input.toolName}(query="${input.toolQuery}")`,
    "",
    "【現在の env block (Yui が持っている情報)】",
    input.envBlock,
    "",
    "→ この dispatch は必要? JSON で判定:",
  ].join("\n");

  try {
    const res = await callLlm("judge", {
      maxTokens: JUDGE_MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userContent }],
    });
    const raw = res.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();
    return parseDecision(raw);
  } catch (e) {
    console.warn("[judge] dispatch-judge failed, defaulting to dispatch:", e);
    return { action: "dispatch", reason: "judge error → safe default" };
  }
}

function parseDecision(raw: string): JudgeDecision {
  // 寛容パース: JSON っぽい部分を抽出
  const match = raw.match(/\{[\s\S]*?\}/);
  if (!match) {
    return { action: "dispatch", reason: "judge output unparseable" };
  }
  try {
    const obj = JSON.parse(match[0]) as Partial<JudgeDecision>;
    if (obj.action === "skip" || obj.action === "dispatch") {
      return {
        action: obj.action,
        reason: typeof obj.reason === "string" ? obj.reason : "",
      };
    }
  } catch {
    // fallthrough
  }
  return { action: "dispatch", reason: "judge json invalid" };
}
