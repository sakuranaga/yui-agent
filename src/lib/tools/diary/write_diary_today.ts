import { generateDiaryEntry } from "@/lib/diary";
import type { ToolDef } from "../types";

export const writeDiaryToday: ToolDef = {
  name: "write_diary_today",
  description:
    "今日の日記を今すぐ書く / 書き直す (通常は cron が深夜に自動生成するので、ユーザーが「今日の日記書いて」と明示的に言った時のみ呼ぶ)。",
  input_schema: {
    type: "object",
    properties: {
      date: { type: "string", description: "(任意) YYYY-MM-DD、省略時は今日" },
    },
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "diary",
  untrustedOutput: false,
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input) => {
    const i = (input ?? {}) as { date?: unknown };
    const date = typeof i.date === "string" ? i.date : undefined;
    const targetDate = date
      ? new Date(`${date}T12:00:00+09:00`)
      : new Date();
    const entry = await generateDiaryEntry({ date: targetDate });
    return `written|${entry.entryDate.toISOString().slice(0, 10)}|${entry.body.length}chars`;
  },
};
