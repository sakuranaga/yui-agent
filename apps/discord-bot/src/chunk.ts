/**
 * Discord の 1 メッセージ上限 2000 字に合わせてテキストを安全に分割する。
 * 段落 (\n\n) を優先境界とし、1 段落が長すぎる時のみ文字単位で切る。
 */
const DISCORD_LIMIT = 2000;
// 体感の安全余白 (markdown コードフェンス等で +α かかる場合に備えて)
const SAFE = 1900;

export function chunkForDiscord(text: string, limit: number = SAFE): string[] {
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.length > 0) {
      out.push(buf);
      buf = "";
    }
  };

  // 段落単位でまず分割
  const paragraphs = text.split(/\n\n+/);
  for (const p of paragraphs) {
    if (p.length <= limit) {
      if (buf.length + (buf ? 2 : 0) + p.length <= limit) {
        buf = buf ? `${buf}\n\n${p}` : p;
      } else {
        flush();
        buf = p;
      }
      continue;
    }
    // 1 段落が長すぎ → 行 → 文字で更に分割
    flush();
    for (const line of p.split(/\n/)) {
      if (line.length <= limit) {
        if (buf.length + (buf ? 1 : 0) + line.length <= limit) {
          buf = buf ? `${buf}\n${line}` : line;
        } else {
          flush();
          buf = line;
        }
      } else {
        // 行も長すぎ → 文字単位
        flush();
        for (let i = 0; i < line.length; i += limit) {
          out.push(line.slice(i, i + limit));
        }
      }
    }
  }
  flush();

  // Discord の実上限 2000 字超えはあり得ないが念のため再チェック
  return out.map((s) => (s.length > DISCORD_LIMIT ? s.slice(0, DISCORD_LIMIT) : s));
}
