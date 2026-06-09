import { createReminder } from "@/lib/reminders";
import type { ToolDef } from "../types";

export const addReminderTool: ToolDef = {
  name: "add_reminder",
  description:
    "リマインダー (予定・習慣の事前通知) を作成。タイマー / アラームとは別機能。" +
    "判定: " +
    "(1) ユーザーが「リマインダー / 教えて / 思い出させて / 忘れないように」明示時、" +
    "(2) 繰り返し (毎朝/毎週/曜日指定) 時、" +
    "(3) TODO/予定と同時生成時 (ref_todo_id あり) は必ずここ。" +
    "「アラーム / 目覚まし / 起こして」明示時のみ create_timer(kind='alarm') を使う。" +
    "時刻指定のみで動詞曖昧な場合は既定でリマインダー (= alarm はデフォルトにしない)。" +
    "title は短い見出し ('ジム' / '薬 (朝)' / '若園さんとランチ')。" +
    "発火時の発話文はサーバ側で動的生成するので、title に発話文を入れない。" +
    "extra_prompt は特殊な指示がある時のみ (普段は空欄でいい)。" +
    "lead_minutes は何分前にリマインドするか (default 0)。",
  input_schema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["habit", "todo_due", "event_due", "custom"],
        description:
          "habit = 繰り返し習慣、todo_due = TODO 期限紐付き、event_due = 予定紐付き、custom = それ以外",
      },
      title: { type: "string", description: "短い見出し" },
      extra_prompt: { type: "string", description: "(任意) speak mode 時の追加指示" },
      schedule_kind: { type: "string", enum: ["once", "weekly"] },
      // once 用
      base_at: {
        type: "string",
        description:
          "kind=once 用。RFC3339/ISO8601 (例: '2026-06-05T13:00:00+09:00')。" +
          "予定 (= ランチ自体) の時刻を入れる。リマインド発火時刻はこれから lead_minutes を引いて算出。",
      },
      // weekly 用
      base_time: {
        type: "string",
        description: "kind=weekly 用。HH:MM (JST、例: '08:00')",
      },
      weekdays: {
        type: "array",
        items: { type: "integer", minimum: 0, maximum: 6 },
        description: "0=Sun..6=Sat、空配列 = 毎日",
      },
      // 共通
      lead_minutes: {
        type: "integer",
        minimum: 0,
        description: "何分前にリマインドするか (default 0)",
      },
      // 紐付け (TODO のみ。GCal event との紐付けは無し)
      ref_todo_id: {
        type: "integer",
        description: "(任意) 紐付ける TODO の id (= add_todo の戻り値の id)",
      },
    },
    required: ["kind", "title", "schedule_kind"],
    additionalProperties: false,
  },
  callableBy: [{ kind: "main" }],
  surface: "mutate",
  domain: "reminder",
  allowedModes: ["normal"],
  confirmationPolicy: "auto",
  handler: async (input, ctx) => {
    const i = (input ?? {}) as {
      kind?: "habit" | "todo_due" | "event_due" | "custom";
      title?: unknown;
      extra_prompt?: unknown;
      schedule_kind?: "once" | "weekly";
      base_at?: unknown;
      base_time?: unknown;
      weekdays?: unknown;
      lead_minutes?: unknown;
      ref_todo_id?: unknown;
    };
    if (!i.kind || typeof i.title !== "string" || !i.schedule_kind) {
      throw new Error("kind, title, schedule_kind are required");
    }
    const lead = typeof i.lead_minutes === "number" ? i.lead_minutes : 0;
    let schedule;
    if (i.schedule_kind === "once") {
      if (typeof i.base_at !== "string")
        throw new Error("base_at is required for kind=once");
      schedule = { kind: "once" as const, baseAt: i.base_at, leadMinutes: lead };
    } else {
      if (typeof i.base_time !== "string")
        throw new Error("base_time is required for kind=weekly");
      schedule = {
        kind: "weekly" as const,
        baseTime: i.base_time,
        weekdays: Array.isArray(i.weekdays) ? (i.weekdays as number[]) : [],
        leadMinutes: lead,
      };
    }
    const refTodoId = typeof i.ref_todo_id === "number" ? i.ref_todo_id : null;
    const row = await createReminder({
      sessionId: ctx.sessionId,
      kind: i.kind,
      title: i.title,
      extraPrompt: typeof i.extra_prompt === "string" ? i.extra_prompt : undefined,
      schedule,
      refTable: refTodoId ? "todos" : null,
      refId: refTodoId,
    });
    return {
      created: true,
      id: row.id,
      kind: row.kind,
      title: row.title,
      next_due_at: row.nextDueAt?.toISOString() ?? null,
    };
  },
};
