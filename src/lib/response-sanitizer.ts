/**
 * Yui の応答テキストから内部メタデータ漏洩 / 構造ノイズを削るサニタイザ。
 *
 * tts-dictionary とは別レイヤー:
 *   - tts-dictionary = 読み方の正規化 (記号 → 単語、漢字読み補正)。TTS 経路のみ。
 *   - response-sanitizer = 構造的な漏洩除去。吹き出し表示・TTS・DB 保存の前段で
 *     共通に走らせる。新しい漏洩パターンが出てきたらここに集約する。
 *
 * 適用箇所: src/app/api/chat/route.ts の reply 確定直後 (emotion 判定 / SSE push /
 * raw_messages persist / TTS 送信より前)。
 */

/**
 * 過去メッセージ履歴の頭に内部で付けてる `[2026-05-29 06:28 JST]` タイムスタンプを
 * 削除する。yui-prompt.ts で「自分の応答に含めるな」と明示してるが、稀に Yui が
 * そのまま喋りだしてしまう (画像のケース: `[2026-06-01 08:51 JST] おかえりなさいませ`)。
 *
 * 許容するゆらぎ:
 *   - 角括弧の内側に空白あり/なし
 *   - HH:MM だけ / HH:MM:SS 両方
 *   - JST が "+09:00" になっているレア case (yui-prompt は JST 固定だが念のため)
 *   - 末尾 (削除後の) 余白も一緒に詰める
 */
const JST_TIMESTAMP_RE =
  /\[\s*\d{4}-\d{2}-\d{2}[T\s]+\d{1,2}:\d{2}(?::\d{2})?\s*(?:JST|\+09:?00)\s*\]\s*/g;

/**
 * システムプロンプト由来の内部ディレクティブを Yui が本文に模倣 echo した場合の除去。
 * #1 (会話モデル) が system の `<yui_directive>` / `[internal-directive-policy]` 形式を真似て
 * `[internal_directive] … [/internal_directive]` 等を本文に出すことがある (実害: 内部指示が本文に漏れる)。
 *
 * **対象は directive 系タグ名に限定** (Codex Medium): 任意の `[tag]…[/tag]` を消すと
 * Yui が通常文で使う `[note]…[/note]` 等を失う。directive 名のみ対象にする。
 * XML 形式 (`<yui_directive>…</yui_directive>`) と 角括弧形式の両方、対ブロック + 単独タグを除去。
 */
const DIRECTIVE_NAMES = "internal[-_ ]?directive|yui[-_ ]?directive|directive[-_ ]?policy";
// 中身ごと: <yui_directive>…</yui_directive>
const XML_DIRECTIVE_RE = new RegExp(`<(?:${DIRECTIVE_NAMES})[^>]*>[\\s\\S]*?<\\/(?:${DIRECTIVE_NAMES})[^>]*>\\s*`, "gi");
// 中身ごと: [internal_directive]…[/internal_directive]
const PAIRED_DIRECTIVE_RE = new RegExp(`\\[(?:${DIRECTIVE_NAMES})[^\\]]*\\][\\s\\S]*?\\[\\/(?:${DIRECTIVE_NAMES})[^\\]]*\\]\\s*`, "gi");
// 対にならず残った単独タグ (XML / 角括弧)
const STANDALONE_DIRECTIVE_RE = new RegExp(`(?:<\\/?(?:${DIRECTIVE_NAMES})[^>]*>|\\[\\/?(?:${DIRECTIVE_NAMES})[^\\]]*\\])\\s*`, "gi");

/**
 * tool_call をテキストで書いてしまった漏れ (`[create_timer(...)]` 等) を本文から除去。
 * 構造化 tool_call ではないので実行もされない純粋なノイズ。会話モデルが tool 記法を
 * 本文に書いた場合 / 汚染履歴を模倣した場合の防御。snake_case 関数名 + 括弧 + 角括弧の形に限定。
 */
const TEXT_TOOLCALL_RE = /\[[a-z][a-z0-9_]*\([^\]]*\)\]\s*/g;

/**
 * 過去 assistant turn の toolSummary を履歴へ注入していた内部ログ表記。
 * これはモデル向け idempotency シグナルで、ユーザー向け本文には絶対に出さない。
 */
const INTERNAL_EXECUTION_LOG_RE =
  /\s*\[(?:内部実行ログ|internal execution log)\s*[—-]\s*[^\]]*\]\s*/gi;

export function sanitizeAssistantText(text: string): string {
  if (!text) return text;
  return text
    .replace(JST_TIMESTAMP_RE, "")
    .replace(XML_DIRECTIVE_RE, "")
    .replace(PAIRED_DIRECTIVE_RE, "")
    .replace(STANDALONE_DIRECTIVE_RE, "")
    .replace(TEXT_TOOLCALL_RE, "")
    .replace(INTERNAL_EXECUTION_LOG_RE, "\n")
    .trimStart()
    .trimEnd();
}
