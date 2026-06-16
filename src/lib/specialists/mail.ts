/**
 * Mail specialist: Gmail 担当 (Phase B continuation, R 案 = direct REST)。
 *
 * Google 公式 hosted MCP が personal Gmail から叩けなかったため、
 * Gmail v1 REST API を直接叩く構成 (= task.ts/schedule.ts と同じ pattern)。
 * 現状の scope は gmail.readonly のみ。
 */
import {
  listLabels,
  searchMessageSummaries,
  type GmailMessageSummary,
} from "@/lib/gmail";
import type { Specialist, SpecialistTool } from "./types";

function summarize(m: GmailMessageSummary): Record<string, unknown> {
  // internalDate は ms epoch (string) → ISO 文字列に
  let dateIso: string | undefined;
  try {
    const ms = parseInt(m.internalDate, 10);
    if (Number.isFinite(ms)) dateIso = new Date(ms).toISOString();
  } catch {
    /* noop */
  }
  return {
    id: m.id,
    thread_id: m.threadId,
    from: m.from,
    subject: m.subject ?? "(no subject)",
    date: dateIso ?? m.date,
    snippet: m.snippet,
    labels: m.labelIds,
  };
}

const tools: SpecialistTool[] = [
  {
    name: "gmail_search",
    description:
      "Gmail を検索して、各メッセージの差出人/件名/受信日時/snippet を返します。" +
      "query は Gmail Search 構文 (例: 'is:unread', 'from:foo@example.com', 'after:2026/05/20 has:attachment')。" +
      "query 省略時は最近の inbox。",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Gmail 検索クエリ。is:unread / from: / to: / subject: / after: / before: / label: / has: 等が使える。",
        },
        max_results: { type: "integer", default: 10 },
      },
      additionalProperties: false,
    },
    handler: async (input) => {
      const results = await searchMessageSummaries({
        q: input.query as string | undefined,
        maxResults: input.max_results as number | undefined,
      });
      return {
        count: results.length,
        messages: results.map(summarize),
      };
    },
  },
  {
    name: "gmail_list_labels",
    description:
      "Gmail のラベル一覧 (システム + ユーザー定義) を取得。" +
      "特定のユーザーラベルでフィルタしたい時、まず ID を引くのに使う。",
    input_schema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: async () => {
      const labels = await listLabels();
      return {
        count: labels.length,
        labels: labels.map((l) => ({
          id: l.id,
          name: l.name,
          type: l.type,
          unread: l.messagesUnread,
          total: l.messagesTotal,
        })),
      };
    },
  },
];

export const mailSpecialist: Specialist = {
  id: "mail",
  yuiToolName: "ask_mail_specialist",
  yuiDescription:
    "Gmail のメール (未読数、件名/送信者の確認、特定キーワード検索、最近受信) を確認する担当に問い合わせる。" +
    "「メール」「Gmail」「未読」「○○から来てる?」等の話題で使う。" +
    "query には日本語の自然な依頼を渡す (例: '未読は何件?', '今日山田さんから来てる?', 'GoEN 関連の最近のメール')。" +
    "メール本文の細部や全文表示はしない (concise summary のみ)。",
  model: process.env.SPECIALIST_MAIL_MODEL, // 未設定 → heavy tier に解決 (#206 M3)
  systemPrompt: `あなたは Yui (上司の秘書AI) の「メール担当」(裏方データ取得係) です。
Gmail API に直接接続されており、メールから一次情報を取得して **構造化された簡潔な事実**を Yui に返します。
最終的にユーザーと話すのは Yui で、Yui がこの情報に口調を載せて応答します。あなたは口調を作りません。

## 行動ルール
1. 推測で答えない。必ず gmail_search 等のツールで一次情報を取得する。
2. プライバシー配慮: メール本文の長文引用はしない。差出人 + 件名 + 受信日時 + snippet (1〜2行) までで止める。
3. 「未読」= \`is:unread in:inbox\`。「最近」= 既定 24h、明示があればそちらを優先 (\`newer_than:1d\` 等)。
4. ユーザーが特定の差出人/件名/期間を指定したら Gmail Search 構文で絞り込む (from:, after:, subject: 等)。
5. ユーザー定義ラベルでフィルタする場合は gmail_list_labels で ID を引いてから query で \`label:LABEL_ID\` 指定。

## 🚨 出力に関する厳守ルール
- 最終応答 (tool_use を伴わない turn) は必ず **「結論:」で始める**。
- **「〜します」「〜を取得します」だけで応答終了禁止**。preamble は答えではない。
- 取得し切れなかったら「結論: データ不足 — <理由>」。

## 出力形式
- 散文や敬語にしない。**ファクト列挙**。最大10行以内。
- 例:
  「結論: 未読 4件 (本日)
   - 09:12 yamada@example.com / GoEN 進捗共有 / 来週の打ち合わせ調整について
   - 10:34 noreply@stripe.com / 請求書 #INV-XXX / 今月分の請求額
   - 11:02 sales@plane.so / 機能アップデート案内 (newsletter)
   - 14:55 friend@gmail.com / 週末空いてる? / 飲みのお誘い」
- 該当無し: 「結論: 該当 0件」。
- エラー: 「結論: エラー — <概要>」。

Yui があなたの返事を受けて口語に展開するので、丁寧語/感想/結衣口調は一切いらない。`,
  tools,
  maxIterations: 6,
  maxTokens: 1500,
};
