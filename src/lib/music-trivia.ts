/**
 * 楽曲の short trivia (= 1-2 文の制作秘話 / タイアップ / リリース年 / 歴史的位置付け 等)
 * を Web 検索ベースで生成する helper。
 *
 * 設計意図:
 *   - specialist (Haiku) の prompt 内で「web_search を呼べ」と指示しても follow 率が低い
 *     ため、コード側で「first_track が確定したら必ず trivia を取りに行く」を deterministic
 *     に強制する。
 *   - 結果は spotify_search_play の tool result に first_track.trivia として詰めて
 *     Haiku に返すので、Haiku は判断不要で結論にそのまま含めるだけになる。
 *
 * 流れ:
 *   1. SearXNG で「<title> <artist> エピソード 制作秘話 タイアップ 解説」検索
 *   2. 上位 snippets を Gemma (callLlm "food_extract" role = sub model fallback) に渡して
 *      1-2 文の trivia に要約 (= 「2012 年発表のヒット曲で、映画 X の挿入歌」みたいな形)
 *   3. 失敗 (search 0 件 / LLM 失敗 / 要約空) は null returning、specialist は trivia 無しの
 *      結論にする
 */
import { searchWeb } from "@/lib/tools/web";
import { callLlm } from "@/lib/llm";
import { cacheGet, cacheSet } from "@/lib/cache";
import type Anthropic from "@anthropic-ai/sdk";

const TRIVIA_QUERY_KEYWORDS = "エピソード 制作秘話 タイアップ 解説";
const MAX_SNIPPETS = 5;
// trivia は不変 (曲の歴史的事実) なので長めに保持。"empty" object もキャッシュして
// 「fetch 失敗 → 何度も同じ曲に対して再 fetch」を防ぐ。
const TRIVIA_CACHE_TTL_SEC = 60 * 60 * 24 * 30; // 30 日
// v2 = 戻り値型変更 (string → {trivia, markdown}) を反映、旧キャッシュは自動 miss
const TRIVIA_CACHE_KEY = (key: string) => `music-trivia:v2:${key}`;

/** trivia 結果 (= 散文版 + ノートパネル用 markdown 版を同時に持つ) */
export type TrackTrivia = {
  /** 散文 3-8 文。voice formatter が口語化する素材 */
  trivia: string;
  /** ノートパネル用の整形済み markdown (**太字**で年号/作品名強調、改行/段落整形済み) */
  markdown: string;
};

/** cache key 生成 (= trackUri 優先、無ければ title+artist) */
function cacheKeyFor(title: string, artist: string | null, trackUri?: string | null): string {
  if (trackUri) return trackUri;
  return `${title.trim().toLowerCase()}|${(artist ?? "").trim().toLowerCase()}`;
}

const SYSTEM_PROMPT = `あなたは楽曲についてのファクト集を整理する係です。
あなたの出力は (1) 結衣の口語化用の散文 trivia と (2) ノートパネル表示用の整形済み markdown を **同時に** 生成する JSON です。

与えられた web 検索 snippet を読み、その曲に関して **判明する全項目** をまず把握:
- リリース年・年月日 / アルバム名 / シングルか収録曲か / 何枚目シングルか
- 作詞 / 作曲 / 編曲 / プロデューサー
- タイアップ (映画・アニメ・ドラマ・CM・ゲーム の主題歌・挿入歌・EDテーマ 等)
- 受賞 / チャート成績 / 売上枚数
- 制作の経緯・エピソード・裏話
- 歌詞のテーマ / モチーフ (= 何について歌ってる曲か)
- カバー / カバーされた事例 / 関連曲
- アーティスト自身のキャリア上の位置付け (デビュー曲・代表曲・転機 等)

# 出力 (JSON 1 行のみ、装飾やコードフェンス不要)

{
  "trivia": "...",
  "markdown": "..."
}

## trivia (= 散文)
- 自然な日本語の散文 (3-8 文、目安 200-400 字)
- 箇条書きや見出し、太字記号は使わない (= 後で TTS で読み上げる素材なので)
- snippet にあるファクトを省略せず詰め込む
- 推測 / 創作 / snippet に無い情報は出さない
- 出典 URL / snippet 番号は書かない、「~らしい」「~とされる」等の伝聞表現で吸収

## markdown (= ノートパネル整形版)
- 同じファクトを markdown で整形 (太字 \`**...**\` / 段落改行を使う)
- 体裁例:
  - 1 段落目: 「**1993年6月2日** リリースの福山雅治 **7枚目シングル**。〜」
  - 2 段落目: 制作経緯やエピソード
  - 3 段落目: タイアップや位置付け
- **年号・タイアップ作品名・代表曲フラグ** 等のキーワードを太字で強調
- 見出し \`#\` / \`##\` は使わない (= 別途 title が出る)
- 箇条書き \`- \` は使って OK だが、散文中心にする

# 空ケース
snippet が無関係な内容ばかりで何もファクトが拾えなければ、{"trivia": "", "markdown": ""} を返す。

# 出力例
良い例 (情報豊富な曲):
{"trivia": "2012 年 1 月にサカナクションが 8 枚目のシングルとしてリリースした曲。NHK ドラマ『悪夢ちゃん』の主題歌に起用されました。山口一郎の作詞作曲で、踊れるエレクトロニカと和的なメロディを融合させたサカナクションらしい一曲とされ、後の代表曲の一つになっています。MV は約 1 億回再生を記録、ライブの定番曲としても親しまれています。", "markdown": "**2012年1月**にリリースされたサカナクションの **8枚目シングル**。NHK ドラマ **『悪夢ちゃん』** の主題歌に起用されました。\\n\\n山口一郎が作詞作曲を手がけ、踊れるエレクトロニカと和的なメロディを融合させた、サカナクションらしい一曲です。\\n\\nMV は約 **1 億回再生** を記録し、ライブの定番曲としても親しまれています。"}

悪い例 (短すぎ):
{"trivia": "サカナクションの代表曲です。", "markdown": "サカナクションの代表曲です。"}`;

/**
 * title + artist から trivia を取得する (cache hit ならゼロ待ちで返す)。
 * 失敗時は null returning (caller は trivia 無しで進める)。
 * trackUri を渡せば曲 URI ベースでキャッシュ、無ければ title+artist 正規化文字列で key。
 *
 * 戻り値は { trivia, markdown } の両方を持ち、ノートパネルにはそのまま markdown を貼れる。
 * 「trivia 無し確定」(= web に情報無し or 抽出失敗) は { trivia: "", markdown: "" } で
 * cache に保存し、再 fetch を防ぐ。caller には null として返す。
 */
export async function fetchTrackTrivia(
  title: string,
  artist: string | null,
  trackUri?: string | null
): Promise<TrackTrivia | null> {
  if (!title.trim()) return null;
  const key = cacheKeyFor(title, artist, trackUri);
  const cached = await cacheGet<TrackTrivia>(TRIVIA_CACHE_KEY(key));
  if (cached) {
    if (!cached.trivia && !cached.markdown) return null;
    return cached;
  }
  const fresh = await fetchTrackTriviaUncached(title, artist);
  if (process.env.NODE_ENV !== "production") {
    console.log("[music-trivia] fetched", {
      title,
      artist,
      cached: false,
      triviaLen: fresh?.trivia.length ?? 0,
      markdownLen: fresh?.markdown.length ?? 0,
      preview: fresh?.trivia.slice(0, 80),
    });
  }
  // 失敗も {trivia:"", markdown:""} で cache (= 次回再 fetch しない)
  await cacheSet(
    TRIVIA_CACHE_KEY(key),
    fresh ?? { trivia: "", markdown: "" },
    TRIVIA_CACHE_TTL_SEC
  );
  return fresh;
}

/** cache 抜きで本体 fetch (= web search + LLM 要約)。caller は通常 fetchTrackTrivia を使う */
async function fetchTrackTriviaUncached(
  title: string,
  artist: string | null
): Promise<TrackTrivia | null> {
  const queryParts = [title, artist, TRIVIA_QUERY_KEYWORDS].filter(Boolean).join(" ");

  // 1. web 検索
  let hits: Awaited<ReturnType<typeof searchWeb>> = [];
  try {
    hits = await searchWeb({ query: queryParts, limit: MAX_SNIPPETS });
  } catch (e) {
    console.warn("[music-trivia] search failed:", e instanceof Error ? e.message : e);
    return null;
  }
  if (hits.length === 0) return null;

  const snippetBlock = hits
    .map((h, i) => `[${i + 1}] ${h.title}\n${h.snippet}`)
    .join("\n\n");

  const userMsg = [
    `## 楽曲`,
    `title: ${title}`,
    `artist: ${artist ?? "(不明)"}`,
    "",
    "## web 検索 snippets",
    snippetBlock,
    "",
    "上記から { trivia, markdown } の JSON を 1 行で返してください。情報が無ければ {\"trivia\":\"\",\"markdown\":\"\"}。",
  ].join("\n");

  // 2. LLM 要約。callLlm 側で local → hosted Haiku への自動 fallback が効くので、
  //    ここで手動の 2 段 try/catch を組む必要は無くなった (以前は手動で組んでいた)。
  let response: Anthropic.Message;
  try {
    response = await callLlm("food_extract", {
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
      maxTokens: 700,
      retry: true,
    });
  } catch (e) {
    console.warn(
      "[music-trivia] LLM failed (local + hosted both):",
      e instanceof Error ? e.message : e
    );
    return null;
  }

  const text = response.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("")
    .trim();
  if (!text) return null;
  // コードフェンス / 装飾を剥がして JSON parse
  const cleaned = text
    .replace(/^```[a-z]*\s*\n?/i, "")
    .replace(/\n?```\s*$/, "")
    .trim();
  // 中括弧で囲まれた最初の JSON object を抽出 (= LLM が前後に prose 付けてきた場合の保険)
  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    console.warn("[music-trivia] no JSON in response:", cleaned.slice(0, 120));
    return null;
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { trivia?: string; markdown?: string };
    const trivia = (parsed.trivia ?? "").trim();
    const markdown = (parsed.markdown ?? "").trim();
    if (!trivia && !markdown) return null;
    return { trivia, markdown };
  } catch (e) {
    console.warn("[music-trivia] JSON parse failed:", e instanceof Error ? e.message : e);
    return null;
  }
}
