/**
 * Yui 発話テキストから 6 種の感情ラベルを推定する軽量分類器。
 *
 * - main chat ターン後 (route.ts) と specialist voice formatter 後
 *   (jobs/dispatcher.ts) の両方から呼ばれる
 * - regex ベース、ゼロ LLM 呼出
 * - 6 種は VRMExpression に対応 (happy/sad/angry/relaxed/surprised/neutral)
 */

export type Emotion =
  | "happy"
  | "sad"
  | "angry"
  | "relaxed"
  | "surprised"
  | "neutral";

export function classifyEmotion(text: string): Emotion {
  if (/(申し訳|ごめんなさい|悲し|つら|寂し|心配|そっか|残念)/.test(text)) {
    return "sad";
  }
  if (/(むっ|許せませ|腹立|怒|だめですよ|いけません)/.test(text)) {
    return "angry";
  }
  if (
    /(びっくり|驚き|まさか|ほんとに|本当に|えっ!|あらまあ|まあっ|まあ!)/.test(text)
  ) {
    return "surprised";
  }
  if (/(ふふっ?|えへへ|嬉し|うれし|楽し|よかった|素敵|ありがと|喜)/.test(text)) {
    return "happy";
  }
  if (
    /(お疲れ|ひと息|ゆっくり|お茶|穏やか|落ち着|ひと休み|ほっと|お休み)/.test(text)
  ) {
    return "relaxed";
  }
  return "neutral";
}
