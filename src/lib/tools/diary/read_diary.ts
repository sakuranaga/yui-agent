import { getDiaryEntry, getLatestDiary } from "@/lib/diary";
import type { ToolDef } from "../types";

export const readDiary: ToolDef = {
  name: "read_diary",
  description:
    "あなた自身の日記を読み返す。" +
    "ユーザーが「あの日の日記」「先日の日記」「今日書いたやつ」等と言ったらこれで本文を取り出す。" +
    "date 省略時は最新エントリ。" +
    "(注: 日記は自分が書いた主観・感情込み文章なので、事実確認用ではなく振り返り・思い出話に使う)",
  input_schema: {
    type: "object",
    properties: {
      date: { type: "string", description: "YYYY-MM-DD (省略時は最新)" },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "read",
  domain: "diary",
  untrustedOutput: false,
  allowedModes: ["normal", "timer", "background"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { date?: unknown };
    const date = typeof i.date === "string" ? i.date : undefined;
    const entry = date ? await getDiaryEntry(date) : await getLatestDiary();
    if (!entry) return "no diary entry";
    return {
      date: entry.entryDate.toISOString().slice(0, 10),
      mood: entry.mood,
      body: entry.body,
    };
  },
};
