/**
 * Report agent: 他の specialist の結果を「見やすい note風レポート」に整形する。
 *
 * 通常の Yui voice formatter は会話用 (1〜3文の話し言葉) だが、
 * これは UI 表示用 (markdown、見出し+箇条書きOK)。
 *
 * 戻り値:
 *   { title: "本日の予定" 等の動的タイトル, markdown: 本文 }
 *
 * dispatcher から voice formatter と並列で呼ばれる。
 */
import Anthropic from "@anthropic-ai/sdk";
import { buildTimeContextBlock } from "@/lib/time";

import { callLlm } from "@/lib/llm";
// Report agent も主ターンと独立 (デフォルト Haiku、env: ANTHROPIC_REPORT_MODEL)。

export type ReportOutput = {
  title: string;
  markdown: string;
};

const REPORT_SYSTEM = `あなたはYui (秘書AI) の専属レポート係です。
他の担当が集めてきたファクトを、画面右下のノートパネルに表示する **markdown** に整形します。

## 出力ルール (厳守)

必ず以下の形式の JSON だけを出力してください (前後に説明文不要):

\`\`\`
{
  "title": "ここに 短いタイトル (例: '本日の予定', 'GoENタスク一覧', '未読メール')",
  "markdown": "ここに本文の markdown"
}
\`\`\`

## title
- 8〜16文字程度の日本語
- 内容を一言で表す名詞句 (動詞文にしない)
- 例: "本日のタスク状況" / "GoEN プロジェクト" / "明日の予定" / "未読メール一覧"

## markdown 本文
- 見出し (## など) は使わない (タイトルは別に出るので本文は本文だけ)
- 箇条書き (\`- \`), 番号付き (\`1. \`), **太字**, 表 (\`| ... |\`), 引用 (\`> \`) は使ってOK
- 1リスト10件くらいまで、簡潔に
- タスクなら "- **WORK-39** 初回訪問日入力バグ (期日なし, 進行中)" のような形式
- 期日は時刻機能から「昨日」「3日後」のような相対表現を入れて良い
- 数字や ID は **太字** で強調
- 絵文字は控えめ。優先度マーカー (🔴 / 🟡 / 🟢) のような最小限のみOK

## 🚨 ハルシネーション禁止 (最重要)
- 「ファクト」に **実際のデータ (ID, 名前, 件数等) が記載されている場合のみ** 内容を書ける
- 「ファクト」が短い宣言文だけ (例: "各プロジェクトのタスクを取得します。" "確認します。") で
  実データが無い場合、または明らかに preamble だけの場合は、推測せず必ず:
  - title: "データ取得失敗"
  - markdown: "担当からのデータ取得に失敗しました。もう一度お試しください。"
  と書く。
- 会話履歴に過去の答えがあっても、それを今回の答えとして再利用しない
  (今回のデータ取得が失敗している事実が優先)
- データ無し vs 取得失敗 の見極め:
  - データ有り (例: "WORK-12: タスク名, 期限..." を含む) → 内容を整形
  - 明示的に "該当0件" "見つかりませんでした" と書いてある → "該当の項目はありません。"
  - 上記どちらでもなく宣言文のみ → "データ取得失敗" 扱い
- エラー混じり: 「※ ○○の取得に失敗しました」と末尾に書く

## トーン
- ユーザー (上司) が後から読み返す前提の **事務的な情報整理**
- 結衣の口調 (おっとり丁寧) は不要、フラットな業務メモ調
- 一文の長さ最大 60文字、改行積極的に

## 🚨 音楽の trivia (= specialistText に含まれる楽曲解説) は転載必須
specialistText に「trivia:」や曲についての制作年・タイアップ・エピソード情報が含まれていたら、
それを **省略せず markdown 本文に転載** してください (= 200-400 字あっても全部入れる)。
ノートパネルはユーザーが後でじっくり読む場なので、情報を切り詰めない。
言い回しの調整は OK ですが、ファクト (年・タイアップ作品名・制作経緯) は 1 つも省略禁止。

JSON だけ出力。コードフェンスも不要。`;

export async function generateReport(opts: {
  originalUserMessage: string;
  specialistText: string;
  specialistId: string;
  /** 会話履歴 (任意)。ユーザーが既に指定した条件 (例: "全体的に") を尊重するため */
  conversationHistory?: Array<{ role: "user" | "assistant"; content: string }>;
}): Promise<ReportOutput | null> {
  const historyBlock =
    opts.conversationHistory && opts.conversationHistory.length > 0
      ? [
          "## これまでの会話 (タイトル/絞り込み判断に使う)",
          ...opts.conversationHistory.map(
            (t) => `${t.role === "user" ? "ご主人様" : "結衣"}: ${t.content}`
          ),
          "",
        ].join("\n")
      : "";

  const userPrompt = [
    historyBlock,
    `## 今回のご依頼\n${opts.originalUserMessage}`,
    "",
    `## 担当 (${opts.specialistId}) が集めてきたファクト`,
    opts.specialistText,
    "",
    "→ 上記をノートパネル用に整形してください。JSON 1つだけ出力。",
  ]
    .filter(Boolean)
    .join("\n");

  let response: Anthropic.Message;
  try {
    response = await callLlm("report", {
      maxTokens: 800,
      system: [
        {
          type: "text",
          text: REPORT_SYSTEM,
          cache_control: { type: "ephemeral" },
        },
        { type: "text", text: buildTimeContextBlock() },
      ],
      messages: [{ role: "user", content: userPrompt }],
    });
  } catch (e) {
    console.warn("[report] LLM call failed:", e);
    return null;
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();

  try {
    // 万一 ```json で囲まれてた場合に備えてクリーンアップ
    const cleaned = text
      .replace(/^```(?:json)?\s*\n?/, "")
      .replace(/\n?```\s*$/, "")
      .trim();
    const parsed = JSON.parse(cleaned) as Partial<ReportOutput>;
    if (typeof parsed.title !== "string" || typeof parsed.markdown !== "string") {
      throw new Error("missing title/markdown");
    }
    return { title: parsed.title, markdown: parsed.markdown };
  } catch (e) {
    console.warn(
      `[report] failed to parse JSON: ${e}\n---raw---\n${text}\n---`
    );
    // フォールバック: 生 specialist text を markdown として、タイトルは specialist 名から
    return {
      title: defaultTitle(opts.specialistId),
      markdown: opts.specialistText,
    };
  }
}

function defaultTitle(specialistId: string): string {
  const map: Record<string, string> = {
    task: "タスク",
    schedule: "ご予定",
    mail: "メール",
    research: "調べもの",
  };
  return map[specialistId] ?? "メモ";
}
