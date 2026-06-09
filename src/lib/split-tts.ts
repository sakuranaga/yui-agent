/**
 * Yui の長文応答を TTS / チャットバブル単位に分割する。
 *
 * - 第一優先: 段落区切り (\n\n 以上の改行)
 * - 1 段落が SOFT_LIMIT を超える場合: 文末記号 (。！？♪…) で更に分割
 * - 連結時もう一度文を結合して HARD_LIMIT 以内に収める (TTS の安全上限)
 *
 * 戻り値の各文字列は trim 済み、空文字は含まない。元のテキストが
 * 短ければ単一要素配列。
 */

// 1 チャンクの目標長さ (これを超えたら文単位で再分割)
const SOFT_LIMIT = 120;
// 1 チャンクの絶対上限 (これを超える文章があったら文単位でも諦めて強制分割)
const HARD_LIMIT = 240;

const SENTENCE_END_RE = /([。！？♪…\?!]+)/;

// URL は分割対象から外す: 「?」や「.」で文末判定されたり、HARD_LIMIT で
// 機械的に切られると壊れるため、placeholder に退避してから処理する。
const URL_RE = /https?:\/\/[^\s　「」『』（）()\[\]<>]+/g;
const URL_TOKEN_RE = /URL(\d+)/g;

function protectUrls(s: string): { masked: string; urls: string[] } {
  const urls: string[] = [];
  const masked = s.replace(URL_RE, (m) => {
    urls.push(m);
    return `URL${urls.length - 1}`;
  });
  return { masked, urls };
}

function restoreUrls(s: string, urls: string[]): string {
  return s.replace(URL_TOKEN_RE, (_, idx) => urls[parseInt(idx, 10)] ?? "");
}

export function splitForTTS(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  // URL を placeholder に退避 (= 文末判定 / hardSplit で壊さない)
  const { masked: text, urls } = protectUrls(trimmed);

  // 1. 段落分割 (空行 = 改行 2 つ以上)
  const paragraphs = text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);

  const out: string[] = [];
  for (const para of paragraphs) {
    // 改行 1 つは TTS では区切らない (同じ段落内なので空白に置換)
    const flat = para.replace(/\n+/g, " ").trim();
    if (flat.length <= SOFT_LIMIT) {
      out.push(flat);
      continue;
    }
    // 文単位に分割 → SOFT_LIMIT 以内に再結合
    const sentences = splitIntoSentences(flat);
    let buf = "";
    for (const s of sentences) {
      if (!buf) {
        buf = s;
      } else if (buf.length + s.length <= SOFT_LIMIT) {
        buf += s;
      } else {
        out.push(buf);
        buf = s;
      }
    }
    if (buf) out.push(buf);
  }

  // HARD_LIMIT 超過チェック (理論上ここで起きるのは1文がそもそも長い場合)
  const splitChunks = out.flatMap((chunk) =>
    chunk.length <= HARD_LIMIT ? [chunk] : hardSplit(chunk)
  );

  // URL placeholder を実 URL に戻す
  return splitChunks.map((c) => restoreUrls(c, urls));
}

/**
 * TTS に渡す用の text 整形: chunk 内の URL を除去 (= TTS は URL を読み上げない)。
 * 「→ 詳しくは https://...」みたいな文は「→ 詳しくは」だけ TTS に渡る。
 * 戻り値が空文字なら呼び出し側で TTS スキップ判定可能。
 */
export function stripUrlForTts(s: string): string {
  return s
    .replace(URL_RE, "")
    // 矢印 「→」「⇒」など、TTS 的に発音 unfriendly な記号を除去
    .replace(/[→⇒⇨▶▸]/g, "")
    // 連続空白を 1 つに圧縮
    .replace(/[\s　]+/gu, " ")
    .trim();
}

/** chunk 内に URL が含まれているか (= display 側で linkify 対象判定用) */
export function containsUrl(s: string): boolean {
  // 新規 RegExp を毎回作って lastIndex の state 汚染を回避
  return /https?:\/\/[^\s「」『』（）()\[\]<>]+/.test(s);
}

/**
 * チャットバブル表示用: text を ["text", { url: "..." }, "text", ...] のセグメント列に分割。
 * URL 部分は { url } で来るので、UI 側で <a> タグ等で render する。
 */
export type DisplaySegment = { kind: "text"; value: string } | { kind: "url"; value: string };

export function splitForDisplay(s: string): DisplaySegment[] {
  const segs: DisplaySegment[] = [];
  const re = /https?:\/\/[^\s「」『』（）()\[\]<>]+/g;
  let lastEnd = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s)) !== null) {
    if (m.index > lastEnd) {
      segs.push({ kind: "text", value: s.slice(lastEnd, m.index) });
    }
    segs.push({ kind: "url", value: m[0] });
    lastEnd = m.index + m[0].length;
  }
  if (lastEnd < s.length) {
    segs.push({ kind: "text", value: s.slice(lastEnd) });
  }
  return segs;
}

function splitIntoSentences(text: string): string[] {
  // 句読点を残しつつ split: ["foo", "。", "bar", "！", ...]
  const parts = text.split(SENTENCE_END_RE);
  const out: string[] = [];
  let buf = "";
  for (const p of parts) {
    if (!p) continue;
    if (SENTENCE_END_RE.test(p)) {
      // 句読点はひとつ前の文に結合
      buf += p;
      if (buf.trim()) out.push(buf.trim());
      buf = "";
    } else {
      buf += p;
    }
  }
  if (buf.trim()) out.push(buf.trim());
  return out;
}

/**
 * 1 文で HARD_LIMIT を超える場合の最終手段: 読点 (、) で区切る、
 * それでも長ければ強制的に文字数で切る。
 */
function hardSplit(chunk: string): string[] {
  const byComma = chunk.split(/、/);
  const out: string[] = [];
  let buf = "";
  for (let i = 0; i < byComma.length; i++) {
    const piece = byComma[i] + (i < byComma.length - 1 ? "、" : "");
    if (!buf) {
      buf = piece;
    } else if (buf.length + piece.length <= HARD_LIMIT) {
      buf += piece;
    } else {
      out.push(buf);
      buf = piece;
    }
  }
  if (buf) out.push(buf);

  // 万一それでもデカい時は文字数で強制切断
  return out.flatMap((s) => {
    if (s.length <= HARD_LIMIT) return [s];
    const slices: string[] = [];
    for (let i = 0; i < s.length; i += HARD_LIMIT) {
      slices.push(s.slice(i, i + HARD_LIMIT));
    }
    return slices;
  });
}
