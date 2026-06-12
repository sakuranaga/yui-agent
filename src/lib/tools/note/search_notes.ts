/**
 * ノート空間を意味検索して、関連ノートの本文を結衣に返すツール (docs/yui-notes.md §4)。
 * 会話中に「前にメモした〜」を引き出す用途。memory (会話記憶) とは別系統。
 *
 * 例:
 *   ご主人様「先週メモした引っ越しの段取り、なんだっけ」
 *   → search_notes("引っ越し 段取り") → 上位ノートを読んで要点を答える
 */
import { getNote, queryNotes } from "@/lib/notes";
import type { ToolDef } from "../types";

const MAX_RETURN = 5;
const BODY_CAP = 2000; // 1 ノートあたり LLM に返す本文の上限文字数

export const searchNotes: ToolDef = {
  name: "search_notes",
  description:
    "ご主人様のノート空間を検索して関連ノートの本文を取得する。" +
    "使うトリガー: 「前にメモした〜」「〜について書いたノートある?」など、" +
    "過去に保存したメモ / 議事録 / レポートを参照したい時。" +
    "結果を読んで会話で要点を答える。会話記憶 (memory) とは別なので、" +
    "明示的に「ノート / メモ」を探す時に使う。",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "検索語 (= 探したいノートの内容を表すキーワードや短い文)。",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "note",
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const query = typeof i.query === "string" ? i.query.trim() : "";
    if (!query) throw new Error("query required");

    const result = await queryNotes({ query });
    const top = result.notes.slice(0, MAX_RETURN);
    // preview だけだと足りないので、上位ノートは本文を取り直して返す
    const detailed = await Promise.all(
      top.map(async (n) => {
        const full = await getNote(n.id);
        return {
          id: n.id,
          title: n.title,
          source: n.source,
          body: (full?.bodyMd ?? n.preview).slice(0, BODY_CAP),
        };
      })
    );
    return { count: result.total, notes: detailed };
  },
};
