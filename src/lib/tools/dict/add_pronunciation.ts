/**
 * 結衣の読み間違いをご主人様が訂正した時に、自律的に TTS 辞書 (= tts_dictionary
 * テーブル) に word → reading を登録するツール。以降の TTS 出力で word が
 * 含まれていれば自動で reading に置換されて喋り直す。
 *
 * 既存 word が登録済みなら reading を上書き更新する (= 訂正にも対応)。
 *
 * 例:
 *   結衣「しょもろこうげんは桜の名所として知られていて...」
 *   ご主人様「小諸高原はこもろこうげんって読むんだよ」
 *   → 結衣が本ツールを呼ぶ → 辞書登録「小諸高原 → こもろこうげん」 → 「覚えました、
 *     こもろこうげんですね」と短く返答
 */
import { db } from "@/db/client";
import { ttsDictionary } from "@/db/schema";
import { invalidateDictionaryCache } from "@/lib/tts-dictionary";
import type { ToolDef } from "../types";

export const addPronunciation: ToolDef = {
  name: "add_pronunciation",
  description:
    "ご主人様から読み方を訂正された時に、その語と正しい読み方を TTS 辞書に登録する。" +
    "登録後は次回以降の発話で自動的に正しい読み方になる (cache TTL 60s)。" +
    "既存登録があれば上書き更新 (= 再訂正にも対応)。" +
    "使うトリガー: 「○○は△△って読むんだよ」「○○は△△と読みます」" +
    "「○○の読み方は△△」のようなご主人様からの読み方訂正発話。" +
    "登録後は「覚えました、△△ですね」のように 1 文で短く確認返答する。",
  input_schema: {
    type: "object",
    properties: {
      word: {
        type: "string",
        description:
          "間違って読まれた語 (= 漢字 / 固有名詞 / 英単語 etc.、例: 「小諸高原」)",
      },
      reading: {
        type: "string",
        description:
          "正しい読み方 (= 平仮名 / 片仮名、例: 「こもろこうげん」)",
      },
    },
    required: ["word", "reading"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "dict",
  allowedModes: ["normal"],
  // 訂正は上書きで簡単に戻せる + 高頻度発生想定なので confirm 不要 (= auto)
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const word = typeof i.word === "string" ? i.word.trim() : "";
    const reading = typeof i.reading === "string" ? i.reading.trim() : "";
    if (!word) throw new Error("word required");
    if (!reading) throw new Error("reading required");

    const [row] = await db
      .insert(ttsDictionary)
      .values({ word, reading, enabled: true })
      .onConflictDoUpdate({
        target: ttsDictionary.word,
        set: { reading, enabled: true, updatedAt: new Date() },
      })
      .returning();
    invalidateDictionaryCache();
    return {
      ok: true,
      word: row.word,
      reading: row.reading,
      action: row.createdAt.getTime() === row.updatedAt.getTime() ? "added" : "updated",
    };
  },
};
