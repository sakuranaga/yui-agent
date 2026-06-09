/**
 * TTS 前処理 (汎用): 任意の日本語テキストを音声合成で自然に読めるよう
 * Haiku で 1:1 正規化する。
 *
 * 使い所:
 *   - 日記 (diary_entries.body_tts) を生成・regenerate した直後
 *   - 朝のブリーフィング Yui voice 用 prompt (cron 経由)
 *   - 将来の本朗読 (book_chunks.normalized_text)
 *
 * 設計方針:
 *   - 文意は変えない、長さもほぼ同じに保つ (要約しない)
 *   - 改行・空行はそのまま保持
 *   - 失敗時は null を返して呼び出し側で生 body にフォールバック
 *
 * docs/roadmap.md §7.8 参照。
 */
import Anthropic from "@anthropic-ai/sdk";
import { callLlm } from "./llm";
import { applyDictionarySubstitution, loadDictionary } from "./tts-dictionary";
import { TTS_DICTIONARY_PRESET } from "./tts-dictionary-preset";

function buildPrompt(dict: Array<{ word: string; reading: string }>): string {
  // DB が空のときの安全網: プリセット (= 初期 seed 対象と同じ集合) を例示に使う。
  // 通常運用では DB seed 済みなので dict.length > 0、こちらは migration 直後の race
  // 等で使われるだけ。
  const effective = dict.length > 0 ? dict : TTS_DICTIONARY_PRESET;
  const dictText = effective.map((d) => `  - ${d.word} → ${d.reading}`).join("\n");
  return BASE_PROMPT.replace("__DICTIONARY__", dictText);
}

const BASE_PROMPT = `あなたは音声合成 (TTS) 前処理エンジンです。
入力テキストを、TTS が自然に正しく読めるよう最小限の変換をした結果だけを出力してください。

【絶対ルール】
- 文意は変えない。要約も加筆もしない。長さもほぼ同じに保つ。
- 改行と空行はそのまま保持する。
- 出力は変換後テキストのみ。前置きや説明文を付けない。コードフェンスやマークダウンも付けない。
- 数字や漢字は読みが自明なら原則そのまま残す (TTS は数字や一般的な漢字は正しく読める)。
  過剰なひらがな化はしない。

【変換ルール】
1. 記号・括弧・全角半角混在を読みに自然な形に整える:
   - "5/27（水）" → "5月27日 水曜日"  (数字・漢字はそのまま、(水) は「水曜日」に展開、/ は「月」に置換)
   - "→" "⇒" は文脈で「やじるし」または省略
   - "/" は「の」「または」などの自然な接続詞に、または「月」(日付の場合)
   - "()" は文意を切る助詞や読点・句点に
   - "・" は読点 (、) に
   - 単位記号 (kg / ℃ / % / m / km / 円) は自然な読みに展開: "12kg" → "12キログラム" (数字は数字のまま、単位だけ仮名化)

2. 【最重要・絶対遵守】用語辞書を 文字単位で完全置換する。辞書にある英数字・略号・固有名詞が
   テキスト中に出現したら、文脈に関わらず必ず指定の読みに置き換える。
   一切の例外なく機械的に適用し、LLM の判断で別の読みを当てたりそのまま残したりしてはいけない。
   - 例: "3Dモデル" → "スリーディーモデル"
   - 例: "3D 印刷" → "スリーディー 印刷"
   - 例: "AIアシスタント" → "エーアイアシスタント"
   - 大文字小文字は区別しない (3D, 3d 両方とも対象)
__DICTIONARY__

3. 辞書にない英単語・固有名詞は、一般的に通用するカタカナ表記にする。

4. 文脈で誤読されやすい漢字だけ ひらがな化する (基本は漢字のまま残す):
   - "○○の方" が方向・選択の意なら "○○のほう" (TTS は「かた」と誤読しがち)
   - "1日" は "ついたち" or "いちにち" を文脈で判断して仮名化
   - "人気"(ひとけ/にんき) "工夫" など同形異音語で誤読の懸念が高い場合のみ仮名化
   - "今日" "明日" "昨日" は読みが自明なので**そのまま残す**

【判定基準】
変換後を声に出して読んだとき自然に聞こえるか。
過剰に仮名化せず、必要な箇所だけピンポイントで直すこと。`;

/**
 * 正規化を実行。失敗時は null を返す (呼び出し側で raw text にフォールバック可能)。
 */
export async function normalizeForTTS(text: string): Promise<string | null> {
  const input = text.trim();
  if (!input) return "";

  try {
    // (1) DB 辞書を pre-substitute (確実に置換) → (2) LLM で記号・漢字読みを整える
    const dict = await loadDictionary();
    const preReplaced = applyDictionarySubstitution(input, dict);
    const res = await callLlm("tts_normalize", {
      maxTokens: Math.min(8192, Math.max(512, preReplaced.length * 2)),
      system: buildPrompt(dict),
      messages: [{ role: "user", content: preReplaced }],
    });
    const out = collectText(res).trim();
    if (!out) return null;
    return out;
  } catch (e) {
    console.warn("[tts-normalize] failed:", e);
    return null;
  }
}

function collectText(msg: Anthropic.Message): string {
  return msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
