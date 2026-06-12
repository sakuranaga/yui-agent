/**
 * ご主人様が「これメモして」「〜を記録しておいて」と言った時に、ノート空間に
 * markdown ノートを保存するツール (docs/yui-notes.md)。source='human' で保存。
 *
 * 例:
 *   ご主人様「さっきの打ち合わせの要点、メモしといて」
 *   → 結衣が要点を markdown にまとめて save_note → 「メモしました」と短く確認
 */
import { createNote } from "@/lib/notes";
import { pushToSession } from "@/lib/jobs/events";
import type { ToolDef } from "../types";

export const saveNote: ToolDef = {
  name: "save_note",
  description:
    "ご主人様の指示でメモ / ノートをノート空間に保存する。markdown 本文を渡す。" +
    "使うトリガー: 「これメモして」「〜を記録しておいて」「ノートに残して」等。" +
    "title は省略可 (= 本文先頭から自動生成)。保存後は「メモしました」のように 1 文で短く確認する。",
  input_schema: {
    type: "object",
    properties: {
      body_md: {
        type: "string",
        description: "ノート本文 (= markdown)。箇条書きや見出しを使ってよい。",
      },
      title: {
        type: "string",
        description: "ノートのタイトル (= 省略時は本文先頭から自動生成)。",
      },
    },
    required: ["body_md"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "note",
  allowedModes: ["normal"],
  // メモ作成は archived で簡単に戻せる低リスク操作なので confirm 不要
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as Record<string, unknown>;
    const bodyMd = typeof i.body_md === "string" ? i.body_md.trim() : "";
    const title = typeof i.title === "string" ? i.title.trim() : undefined;
    if (!bodyMd) throw new Error("body_md required");
    const note = await createNote({ title, bodyMd, source: "human" });
    // 保存したノートを ReportPanel に live 表示 (タイトルタブのクリックで NotesModal を開ける)。
    // 永続化はしない (= ノートは createNote で保存済み)。push 失敗で tool 自体は失敗させない。
    try {
      pushToSession(ctx.sessionId, {
        type: "report_update",
        jobId: Date.now(),
        title: note.title, // createNote が deriveTitle で常に非空
        markdown: bodyMd,
        noteId: note.id,
      });
    } catch (pushErr) {
      console.warn("[save_note] report_update push failed:", pushErr);
    }
    return { ok: true, id: note.id, title: note.title };
  },
};
