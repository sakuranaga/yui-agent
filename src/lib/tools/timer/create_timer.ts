import { createTimer } from "@/lib/timers";
import type { ToolDef } from "../types";

export const createTimerTool: ToolDef = {
  name: "create_timer",
  description:
    "タイマー (相対秒数カウントダウン) または アラーム (絶対時刻起動) を作成。" +
    "kind='timer' なら duration_seconds 必須、kind='alarm' なら target_at (ISO8601) 必須。" +
    "label は任意 (例: 'ラーメン', '会議', 'メール返信')。" +
    "時刻解釈は time context (JST) を基準に。「6時」が過去なら翌日扱い。" +
    "on_fire_prompt: 発火時に Yui に実行させる内容 (例: 'ポップスかけて', '今日のニュース教えて')。" +
    "ユーザーが「○分後にYして」「○時にYして」と言った時の Y を on_fire_prompt に入れる。" +
    "「ラーメン3分」「5分タイマー」のような単純通知なら on_fire_prompt 省略。",
  input_schema: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["timer", "alarm"] },
      label: { type: "string", description: "(任意) 表示用ラベル" },
      duration_seconds: {
        type: "integer",
        description: "kind=timer 用。相対秒数 (例: 5分=300、1時間=3600)",
      },
      target_at: {
        type: "string",
        description:
          "kind=alarm 用。RFC3339/ISO8601 (例: '2026-05-25T06:00:00+09:00')",
      },
      on_fire_prompt: {
        type: "string",
        description:
          "発火時に Yui に実行させる prompt。例: 'ポップスかけて' / '今日のニュース教えて' / 'タスクの状況を確認して'。省略なら通知のみ。",
      },
    },
    required: ["kind"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "timer",
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
      kind?: "timer" | "alarm";
      label?: unknown;
      duration_seconds?: unknown;
      target_at?: unknown;
      on_fire_prompt?: unknown;
    };
    const row = await createTimer({
      sessionId: ctx.sessionId,
      kind: i.kind ?? "timer",
      label: typeof i.label === "string" ? i.label : undefined,
      durationSeconds:
        typeof i.duration_seconds === "number" ? i.duration_seconds : undefined,
      targetAt: typeof i.target_at === "string" ? i.target_at : undefined,
      onFirePrompt:
        typeof i.on_fire_prompt === "string" ? i.on_fire_prompt : undefined,
    });
    return {
      created: true,
      id: row.id,
      kind: row.kind,
      label: row.label,
      target_at: row.targetAt.toISOString(),
    };
  },
};
