/**
 * GET  /api/reminders?session=<sid>&enabled=true&ref_table=todos&ref_id=42
 *   → 一覧
 * POST /api/reminders
 *   → 新規作成 (body: CreateReminderInput 相当の JSON)
 */
import { NextResponse, type NextRequest } from "next/server";
import {
  createReminder,
  listReminders,
  type CreateReminderInput,
} from "@/lib/reminders";
import type { ReminderSchedule, Reminder } from "@/db/schema";
import { clientError } from "@/lib/api-error";

function serialize(r: Reminder) {
  return {
    id: r.id,
    session_id: r.sessionId,
    kind: r.kind,
    title: r.title,
    extra_prompt: r.extraPrompt,
    schedule: r.schedule,
    ref_table: r.refTable,
    ref_id: r.refId,
    enabled: r.enabled,
    last_fired_at: r.lastFiredAt?.toISOString() ?? null,
    fire_count: r.fireCount,
    next_due_at: r.nextDueAt?.toISOString() ?? null,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const sessionId = sp.get("session") ?? undefined;
  const enabledRaw = sp.get("enabled");
  const enabled =
    enabledRaw === "true" ? true : enabledRaw === "false" ? false : undefined;
  const refTable = sp.get("ref_table") ?? undefined;
  const refIdStr = sp.get("ref_id");
  const refId = refIdStr ? parseInt(refIdStr, 10) : undefined;
  try {
    const list = await listReminders({ sessionId, enabled, refTable, refId });
    return NextResponse.json({
      count: list.length,
      reminders: list.map(serialize),
    });
  } catch (e) {
    return clientError(req, e, { context: "reminders", message: "リマインダー一覧の取得に失敗しました" });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as Partial<CreateReminderInput>;
    if (!body.sessionId || !body.title || !body.schedule || !body.kind) {
      return NextResponse.json(
        { error: "sessionId, kind, title, schedule are required" },
        { status: 400 }
      );
    }
    const validated = validateSchedule(body.schedule);
    if (!validated.ok) {
      return NextResponse.json({ error: validated.error }, { status: 400 });
    }
    const row = await createReminder({
      sessionId: body.sessionId,
      kind: body.kind,
      title: body.title,
      extraPrompt: body.extraPrompt ?? null,
      schedule: body.schedule,
      refTable: body.refTable ?? null,
      refId: body.refId ?? null,
    });
    return NextResponse.json(serialize(row));
  } catch (e) {
    return clientError(req, e, { context: "reminders", message: "リマインダーの作成に失敗しました" });
  }
}

function validateSchedule(s: ReminderSchedule): { ok: true } | { ok: false; error: string } {
  if (s.kind === "once") {
    if (!s.baseAt) return { ok: false, error: "schedule.baseAt required" };
    if (Number.isNaN(new Date(s.baseAt).getTime()))
      return { ok: false, error: "invalid baseAt" };
    if (typeof s.leadMinutes !== "number" || s.leadMinutes < 0)
      return { ok: false, error: "leadMinutes must be >= 0" };
    return { ok: true };
  }
  if (s.kind === "weekly") {
    if (!/^\d{2}:\d{2}$/.test(s.baseTime))
      return { ok: false, error: "baseTime must be HH:MM" };
    if (!Array.isArray(s.weekdays))
      return { ok: false, error: "weekdays must be array" };
    if (s.weekdays.some((w) => w < 0 || w > 6))
      return { ok: false, error: "weekdays must be 0..6" };
    if (typeof s.leadMinutes !== "number" || s.leadMinutes < 0)
      return { ok: false, error: "leadMinutes must be >= 0" };
    return { ok: true };
  }
  return { ok: false, error: "schedule.kind must be once or weekly" };
}
