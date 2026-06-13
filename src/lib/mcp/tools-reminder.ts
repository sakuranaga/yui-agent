/**
 * ゆい MCP サーバ: リマインダー tool (docs/yui-mcp-server.md §5.3)。
 * flat な MCP schema から ReminderSchedule を組み立てて既存 lib (reminders.ts) を呼ぶ。
 * 物理削除 (deleteReminder) は公開せず、disable (enabled=false) をソフト削除とする。
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createReminder, listReminders, updateReminder } from "@/lib/reminders";
import type { ReminderSchedule, Reminder } from "@/db/schema";
import { MCP_OWNER_SESSION_ID } from "./const";

function ok(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data as Record<string, unknown>,
  };
}
function fail(context: string, e: unknown, message: string) {
  console.error(`[mcp:${context}]`, e instanceof Error ? e.message : e);
  return {
    content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}

const SCHEDULE_KIND = z.enum(["once", "weekly"]);
const REMINDER_KIND = z.enum(["habit", "todo_due", "event_due", "custom"]);

/** flat 入力から ReminderSchedule を組み立てる (= add_reminder tool と同じ体系)。 */
function buildSchedule(input: {
  schedule_kind: "once" | "weekly";
  base_at?: string;
  base_time?: string;
  weekdays?: number[];
  lead_minutes?: number;
}): ReminderSchedule {
  const lead = input.lead_minutes ?? 0;
  if (input.schedule_kind === "once") {
    if (!input.base_at || input.base_at.trim() === "") {
      throw new Error("base_at is required for schedule_kind=once");
    }
    if (Number.isNaN(new Date(input.base_at).getTime())) {
      throw new Error(`invalid base_at: ${input.base_at}`);
    }
    return { kind: "once", baseAt: input.base_at, leadMinutes: lead };
  }
  const m = /^(\d{1,2}):(\d{2})$/.exec(input.base_time ?? "");
  if (!m) throw new Error("base_time (HH:MM) is required for schedule_kind=weekly");
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh > 23 || mm > 59) throw new Error(`invalid base_time (out of range): ${input.base_time}`);
  return {
    kind: "weekly",
    baseTime: m[0], // = 検証済みの base_time 文字列 (anchored regex なので全体一致)
    weekdays: input.weekdays ?? [],
    leadMinutes: lead,
  };
}

function reminderView(r: Reminder) {
  return {
    id: r.id,
    kind: r.kind,
    title: r.title,
    enabled: r.enabled,
    next_due_at: r.nextDueAt ? r.nextDueAt.toISOString() : null,
    schedule: r.schedule,
  };
}

export function registerReminderTools(server: McpServer): void {
  server.registerTool(
    "reminder_add",
    {
      title: "リマインダー追加",
      description:
        "リマインダーを作成する。schedule_kind=once は base_at(ISO8601)、weekly は base_time(HH:MM) + weekdays(0=日..6=土、空=毎日)。lead_minutes は何分前に通知するか。",
      inputSchema: {
        title: z.string().trim().min(1).describe("短い見出し (例 'ジム' '薬(朝)')"),
        schedule_kind: SCHEDULE_KIND,
        base_at: z.string().optional().describe("once 用 ISO8601"),
        base_time: z.string().optional().describe("weekly 用 HH:MM (JST)"),
        weekdays: z
          .array(z.number().int().min(0).max(6))
          .optional()
          .describe("weekly 用 0=日..6=土、空=毎日"),
        lead_minutes: z.number().int().min(0).optional().describe("何分前に通知 (既定 0)"),
        kind: REMINDER_KIND.optional().describe("既定 custom"),
        extra_prompt: z.string().optional().describe("発話時の追加指示 (任意)"),
      },
    },
    async ({ title, schedule_kind, base_at, base_time, weekdays, lead_minutes, kind, extra_prompt }) => {
      try {
        const schedule = buildSchedule({ schedule_kind, base_at, base_time, weekdays, lead_minutes });
        const row = await createReminder({
          sessionId: MCP_OWNER_SESSION_ID,
          kind: kind ?? "custom",
          title,
          extraPrompt: extra_prompt,
          schedule,
        });
        return ok({ id: row.id, title: row.title, next_due_at: row.nextDueAt?.toISOString() ?? null });
      } catch (e) {
        return fail("reminder_add", e, "リマインダーの作成に失敗しました");
      }
    }
  );

  server.registerTool(
    "reminder_list",
    {
      title: "リマインダー一覧",
      description: "リマインダーを一覧する。include_disabled で無効分も含む。",
      inputSchema: {
        include_disabled: z.boolean().optional().describe("無効分も含めるか (既定 false=有効のみ)"),
      },
    },
    async ({ include_disabled }) => {
      try {
        const rows = await listReminders(
          include_disabled ? {} : { enabled: true }
        );
        return ok({ reminders: rows.map(reminderView) });
      } catch (e) {
        return fail("reminder_list", e, "リマインダーの一覧取得に失敗しました");
      }
    }
  );

  server.registerTool(
    "reminder_update",
    {
      title: "リマインダー更新",
      description:
        "id を指定して title / extra_prompt / スケジュールを更新する。schedule_kind を渡した時のみスケジュール再構築。",
      inputSchema: {
        id: z.number().int().positive(),
        title: z.string().optional(),
        extra_prompt: z.string().nullable().optional(),
        schedule_kind: SCHEDULE_KIND.optional(),
        base_at: z.string().optional(),
        base_time: z.string().optional(),
        weekdays: z.array(z.number().int().min(0).max(6)).optional(),
        lead_minutes: z.number().int().min(0).optional(),
      },
    },
    async ({ id, title, extra_prompt, schedule_kind, base_at, base_time, weekdays, lead_minutes }) => {
      try {
        const schedule = schedule_kind
          ? buildSchedule({ schedule_kind, base_at, base_time, weekdays, lead_minutes })
          : undefined;
        const row = await updateReminder({ id, title, extraPrompt: extra_prompt, schedule });
        if (!row) return ok({ updated: false, id });
        return ok({ updated: true, id: row.id, next_due_at: row.nextDueAt?.toISOString() ?? null });
      } catch (e) {
        return fail("reminder_update", e, "リマインダーの更新に失敗しました");
      }
    }
  );

  server.registerTool(
    "reminder_disable",
    {
      title: "リマインダー無効化",
      description:
        "リマインダーを無効化する (= ソフト削除)。物理削除は MCP からはできない。",
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => {
      try {
        const row = await updateReminder({ id, enabled: false });
        if (!row) return ok({ disabled: false, id });
        return ok({ disabled: true, id: row.id, enabled: row.enabled });
      } catch (e) {
        return fail("reminder_disable", e, "リマインダーの無効化に失敗しました");
      }
    }
  );
}
