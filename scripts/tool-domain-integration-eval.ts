import assert from "node:assert/strict";
import { sql } from "@/db/client";
import { deleteNote } from "@/lib/notes";
import { addTodoTool } from "@/lib/tools/todo/add_todo";
import { searchTodosTool } from "@/lib/tools/todo/search_todos";
import { completeTodoTool } from "@/lib/tools/todo/complete_todo";
import { deleteTodoTool } from "@/lib/tools/todo/delete_todo";
import { saveNote } from "@/lib/tools/note/save_note";
import { searchNotes } from "@/lib/tools/note/search_notes";
import { addContactTool } from "@/lib/tools/contact/add_contact";
import { searchContactsTool } from "@/lib/tools/contact/search_contacts";
import { findContactTool } from "@/lib/tools/contact/find_contact";
import { appendContactNoteTool } from "@/lib/tools/contact/append_contact_note";
import { deleteContactTool } from "@/lib/tools/contact/delete_contact";
import { gcalCreateEvent } from "@/lib/tools/schedule/gcal_create_event";
import { gcalGetEvent } from "@/lib/tools/schedule/gcal_get_event";
import { gcalListEvents } from "@/lib/tools/schedule/gcal_list_events";
import { gcalDeleteEvent } from "@/lib/tools/schedule/gcal_delete_event";
import { addReminderTool } from "@/lib/tools/reminder/add_reminder";
import { listRemindersTool } from "@/lib/tools/reminder/list_reminders";
import { deleteReminderTool } from "@/lib/tools/reminder/delete_reminder";
import type { ToolContext } from "@/lib/tools/types";

type EvalCase = {
  name: string;
  run: () => Promise<void>;
};

const runId = `tool-eval-${Date.now()}`;
const sessionId = `tool-domain-eval-${runId}`;
const allowExternalSkip = process.env.TOOL_DOMAIN_EVAL_ALLOW_EXTERNAL_SKIP === "1";
const cases: EvalCase[] = [];
const cleanupTasks: Array<() => Promise<void>> = [];

function ctx(caller: ToolContext["caller"] = { kind: "main" }): ToolContext {
  return {
    sessionId,
    caller,
    mode: "normal",
    userUtterance: null,
    availabilityCache: new Map(),
  };
}

function test(name: string, run: () => Promise<void>) {
  cases.push({ name, run });
}

function asRecord(v: unknown): Record<string, unknown> {
  assert.equal(typeof v, "object");
  assert.notEqual(v, null);
  assert.equal(Array.isArray(v), false);
  return v as Record<string, unknown>;
}

function parseIdentifier(output: unknown, prefix: "T" | "C"): string {
  assert.equal(typeof output, "string");
  const m = new RegExp(`\\b${prefix}-\\d+\\b`).exec(output as string);
  assert.ok(m, `identifier ${prefix}-N not found in ${output}`);
  return m[0];
}

let todoIdentifier = "";
let noteId = 0;
let contactIdentifier = "";
let gcalEventId = "";
let reminderId = 0;

test("todo add/search/complete/delete", async () => {
  const title = `${runId} TODO 牛乳`;
  const added = await addTodoTool.handler(
    { title, tags: [runId], note: "tool domain integration eval" },
    ctx(),
  );
  todoIdentifier = parseIdentifier(added, "T");
  cleanupTasks.push(async () => {
    if (todoIdentifier) await deleteTodoTool.handler({ identifier: todoIdentifier }, ctx()).catch(() => undefined);
  });

  const searched = String(await searchTodosTool.handler({ query: runId, limit: 10 }, ctx()));
  assert.match(searched, new RegExp(todoIdentifier));
  assert.match(searched, new RegExp(title));

  const completed = String(await completeTodoTool.handler({ identifier: todoIdentifier }, ctx()));
  assert.match(completed, /done/);

  const deleted = String(await deleteTodoTool.handler({ identifier: todoIdentifier }, ctx()));
  assert.match(deleted, /deleted/);
  todoIdentifier = "";
});

test("note save/search/delete", async () => {
  const title = `${runId} メモ`;
  const body = `# ${title}\n\n今日はツール回帰テストをした。検索語: ${runId}`;
  const saved = asRecord(await saveNote.handler({ title, body_md: body }, ctx()));
  noteId = Number(saved.id);
  assert.ok(noteId > 0);
  cleanupTasks.push(async () => {
    if (noteId) await deleteNote(noteId).catch(() => undefined);
  });

  const result = asRecord(await searchNotes.handler({ query: runId }, ctx()));
  assert.ok(Number(result.count) >= 1);
  const notes = result.notes as Array<Record<string, unknown>>;
  assert.ok(notes.some((n) => Number(n.id) === noteId || String(n.title).includes(runId)));

  assert.equal(await deleteNote(noteId), true);
  noteId = 0;
});

test("contact add/search/find/append/delete", async () => {
  const name = `${runId} テスト太郎`;
  const email = `${runId}@example.com`;
  const added = await addContactTool.handler(
    {
      name,
      emails: [{ type: "work", value: email }],
      tags: [runId],
      notes: "初期メモ",
    },
    ctx(),
  );
  contactIdentifier = parseIdentifier(added, "C");
  cleanupTasks.push(async () => {
    if (contactIdentifier) {
      await sql`DELETE FROM contacts WHERE identifier = ${contactIdentifier}`;
    }
  });

  const searched = String(await searchContactsTool.handler({ query: runId, limit: 10 }, ctx()));
  assert.match(searched, new RegExp(contactIdentifier));

  const found = asRecord(await findContactTool.handler({ identifier: contactIdentifier }, ctx()));
  assert.equal(found.identifier, contactIdentifier);
  assert.equal(found.name, name);

  const appended = String(
    await appendContactNoteTool.handler(
      { identifier: contactIdentifier, entry: "回帰テスト用の追記", at: "2026-06-23" },
      ctx(),
    ),
  );
  assert.match(appended, /note appended/);

  const deleted = String(await deleteContactTool.handler({ identifier: contactIdentifier }, ctx()));
  assert.match(deleted, /soft-deleted/);
  await sql`DELETE FROM contacts WHERE identifier = ${contactIdentifier}`;
  contactIdentifier = "";
});

test("reminder add/list/delete", async () => {
  const title = `${runId} リマインダー`;
  const baseAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const added = asRecord(
    await addReminderTool.handler(
      {
        kind: "custom",
        title,
        schedule_kind: "once",
        base_at: baseAt,
        lead_minutes: 0,
      },
      ctx(),
    ),
  );
  reminderId = Number(added.id);
  assert.ok(reminderId > 0);
  cleanupTasks.push(async () => {
    if (reminderId) await deleteReminderTool.handler({ id: reminderId }, ctx()).catch(() => undefined);
  });

  const listed = asRecord(await listRemindersTool.handler({ include_disabled: true }, ctx()));
  const reminders = listed.reminders as Array<Record<string, unknown>>;
  assert.ok(reminders.some((r) => Number(r.id) === reminderId && r.title === title));

  const deleted = asRecord(await deleteReminderTool.handler({ id: reminderId }, ctx()));
  assert.equal(deleted.deleted, true);
  reminderId = 0;
});

test("gcal create/get/list/delete", async () => {
  const scheduleCtx = ctx({ kind: "specialist", id: "schedule" });
  try {
    const available = await gcalCreateEvent.isAvailable?.({
      sessionId,
      availabilityCache: scheduleCtx.availabilityCache,
    });
    assert.equal(available, true, "Google Calendar events scope is not available");
  } catch (e) {
    if (allowExternalSkip) {
      console.warn(
        `[skip] gcal create/get/list/delete: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    throw e;
  }

  const title = `${runId} GCal テスト`;
  const start = new Date(Date.now() + 2 * 60 * 60_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  try {
    const created = asRecord(
      await gcalCreateEvent.handler(
        {
          calendar_id: "primary",
          summary: title,
          description: "Yui tool-domain integration eval. This event should be deleted automatically.",
          start: { dateTime: start.toISOString(), timeZone: "Asia/Tokyo" },
          end: { dateTime: end.toISOString(), timeZone: "Asia/Tokyo" },
        },
        scheduleCtx,
      ),
    );
    const event = asRecord(created.event);
    gcalEventId = String(event.id);
    assert.ok(gcalEventId);
    cleanupTasks.push(async () => {
      if (gcalEventId) {
        await gcalDeleteEvent.handler({ calendar_id: "primary", event_id: gcalEventId }, scheduleCtx).catch(() => undefined);
      }
    });

    const got = asRecord(
      await gcalGetEvent.handler({ calendar_id: "primary", event_id: gcalEventId }, scheduleCtx),
    );
    assert.equal(got.id, gcalEventId);
    assert.equal(got.summary, title);

    const listed = asRecord(
      await gcalListEvents.handler(
        {
          calendar_id: "primary",
          time_min: new Date(start.getTime() - 10 * 60_000).toISOString(),
          time_max: new Date(end.getTime() + 10 * 60_000).toISOString(),
          q: runId,
          max_results: 10,
        },
        scheduleCtx,
      ),
    );
    const events = listed.events as Array<Record<string, unknown>>;
    assert.ok(events.some((e) => e.id === gcalEventId));

    const deleted = asRecord(
      await gcalDeleteEvent.handler({ calendar_id: "primary", event_id: gcalEventId }, scheduleCtx),
    );
    assert.equal(deleted.deleted, true);
    assert.equal(deleted.event_id, gcalEventId);
    gcalEventId = "";
  } catch (e) {
    if (allowExternalSkip) {
      console.warn(
        `[skip] gcal create/get/list/delete: ${e instanceof Error ? e.message : String(e)}`,
      );
      return;
    }
    throw e;
  }
});

async function cleanup() {
  for (const task of cleanupTasks.reverse()) {
    await task();
  }
  await sql`DELETE FROM reminders WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM todos WHERE session_id = ${sessionId}`;
  await sql`DELETE FROM contacts WHERE session_id = ${sessionId}`;
  if (noteId) await deleteNote(noteId).catch(() => undefined);
}

async function main() {
  let passed = 0;
  try {
    for (const c of cases) {
      await c.run();
      passed += 1;
      console.log(`ok ${passed} - ${c.name}`);
    }
    console.log(`\n${passed}/${cases.length} tool domain integration evals passed`);
  } catch (e) {
    console.error(`not ok ${passed + 1} - ${cases[passed]?.name ?? "unknown"}`);
    console.error(e);
    process.exitCode = 1;
  } finally {
    await cleanup();
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sql.end({ timeout: 1 });
    process.exit(process.exitCode ?? 0);
  });
