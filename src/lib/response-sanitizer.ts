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

export function sanitizeAssistantText(text: string): string {
  if (!text) return text;
  return text.replace(JST_TIMESTAMP_RE, "").trimStart();
}
