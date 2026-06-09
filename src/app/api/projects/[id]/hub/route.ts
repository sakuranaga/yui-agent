/**
 * GET /api/projects/[id]/hub
 *
 * Project Hub aggregate: 該当 project に紐付いてる全アーティファクトを
 * 種別ごとに 1 endpoint で集約して返す。Project Hub Modal で「Walls Tokyo の
 * 状況は?」を一覧する用。
 *
 * ## 入出力
 *   GET /api/projects/{id}/hub
 *   response: {
 *     project: { id, name, color, description, archived },
 *     counts:  { todo: {total, by_state}, mail, event, contact, memo },
 *     todos:   Array<{ id, identifier, title, state, priority, due_at,
 *                       completed_at, linked_by }>,
 *     mails:   Array<{ id, subject, from_name, from_email, received_at,
 *                       starred, archived, trashed, linked_by }>,
 *     events:  Array<{ artifact_id, linked_by }>,  // gcal は外部、別途展開
 *     contacts: Array<{ id, name, company, kana, linked_by }>,
 *   }
 *
 * 設計: docs/roadmap.md §6.8 (project-links Phase 3)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import {
  contacts,
  mailMessages,
  projects,
  projectLinks,
  todos,
} from "@/db/schema";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { getEvent, isGCalConfigured } from "@/lib/gcal";

export const dynamic = "force-dynamic";

export async function GET(
  _req: NextRequest,
  ctx: { params: Promise<{ id: string }> }
) {
  const { id } = await ctx.params;
  const projectId = parseInt(id, 10);
  if (!Number.isFinite(projectId) || projectId <= 0) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  // project meta
  const [p] = await db.select().from(projects).where(eq(projects.id, projectId));
  if (!p) return NextResponse.json({ error: "not found" }, { status: 404 });

  // 全 link を 1 クエリで取得
  const links = await db
    .select({
      type: projectLinks.artifactType,
      id: projectLinks.artifactId,
      by: projectLinks.linkedBy,
    })
    .from(projectLinks)
    .where(eq(projectLinks.projectId, projectId));

  const linksByType = new Map<string, Array<{ id: string; by: string }>>();
  for (const l of links) {
    const arr = linksByType.get(l.type) ?? [];
    arr.push({ id: l.id, by: l.by });
    linksByType.set(l.type, arr);
  }

  // todos の詳細を join で取得
  const todoLinks = linksByType.get("todo") ?? [];
  const todoIds = todoLinks
    .map((l) => parseInt(l.id, 10))
    .filter((n) => Number.isFinite(n));
  const todoLinkedBy = new Map(todoLinks.map((l) => [l.id, l.by]));
  const todoRows =
    todoIds.length > 0
      ? await db
          .select({
            id: todos.id,
            identifier: todos.identifier,
            title: todos.title,
            state: todos.state,
            priority: todos.priority,
            dueAt: todos.dueAt,
            completedAt: todos.completedAt,
            createdAt: todos.createdAt,
          })
          .from(todos)
          .where(inArray(todos.id, todoIds))
          .orderBy(asc(todos.completedAt), asc(todos.dueAt), desc(todos.id))
      : [];
  const todoCount = todoRows.length;
  const todoByState = {
    backlog: 0,
    in_progress: 0,
    blocked: 0,
    done: 0,
  } as Record<string, number>;
  for (const t of todoRows) todoByState[t.state] = (todoByState[t.state] ?? 0) + 1;

  // mails の詳細
  const mailLinks = linksByType.get("mail") ?? [];
  const mailIds = mailLinks
    .map((l) => parseInt(l.id, 10))
    .filter((n) => Number.isFinite(n));
  const mailLinkedBy = new Map(mailLinks.map((l) => [l.id, l.by]));
  const mailRows =
    mailIds.length > 0
      ? await db
          .select({
            id: mailMessages.id,
            subject: mailMessages.subject,
            fromName: mailMessages.fromName,
            fromEmail: mailMessages.fromEmail,
            receivedAt: mailMessages.receivedAt,
            starredAt: mailMessages.starredAt,
            archivedAt: mailMessages.archivedAt,
            trashedAt: mailMessages.trashedAt,
          })
          .from(mailMessages)
          .where(inArray(mailMessages.id, mailIds))
          .orderBy(desc(mailMessages.receivedAt))
      : [];

  // contacts の詳細
  const contactLinks = linksByType.get("contact") ?? [];
  const contactIds = contactLinks
    .map((l) => parseInt(l.id, 10))
    .filter((n) => Number.isFinite(n));
  const contactLinkedBy = new Map(contactLinks.map((l) => [l.id, l.by]));
  const contactRows =
    contactIds.length > 0
      ? await db
          .select({
            id: contacts.id,
            name: contacts.name,
            kana: contacts.kana,
            company: contacts.company,
            role: contacts.role,
          })
          .from(contacts)
          .where(and(inArray(contacts.id, contactIds), isNull(contacts.deletedAt)))
          .orderBy(asc(contacts.name))
      : [];

  // events は gcal API から並列で実データ取得。失敗 / 削除済 (404) は skip。
  const eventLinks = linksByType.get("event") ?? [];
  type EnrichedEvent = {
    artifact_id: string;
    linked_by: string;
    summary: string;
    location: string | null;
    start_iso: string | null;
    end_iso: string | null;
    all_day: boolean;
    status: string | null;
  };
  let eventRows: EnrichedEvent[] = [];
  if (eventLinks.length > 0 && isGCalConfigured()) {
    const fetched = await Promise.all(
      eventLinks.map(async (l) => {
        try {
          const e = await getEvent({ eventId: l.id });
          const startIso = e.start?.dateTime ?? e.start?.date ?? null;
          const endIso = e.end?.dateTime ?? e.end?.date ?? null;
          const allDay = !!e.start?.date;
          return {
            artifact_id: l.id,
            linked_by: l.by,
            summary: e.summary ?? "(無題)",
            location: e.location ?? null,
            start_iso: startIso,
            end_iso: endIso,
            all_day: allDay,
            status: e.status ?? null,
          } as EnrichedEvent;
        } catch (err) {
          // 削除済 / 権限失効等は黙って skip (DB 上の link は残しておく → 別途 cleanup)
          console.warn(`[hub] gcal getEvent failed for ${l.id}:`, err instanceof Error ? err.message : err);
          return null;
        }
      })
    );
    eventRows = fetched.filter((x): x is EnrichedEvent => x !== null);
    // 未来の予定 (今日以降) を上、過去はその下に
    const now = Date.now();
    eventRows.sort((a, b) => {
      const ta = a.start_iso ? new Date(a.start_iso).getTime() : 0;
      const tb = b.start_iso ? new Date(b.start_iso).getTime() : 0;
      const aFuture = ta >= now;
      const bFuture = tb >= now;
      if (aFuture && !bFuture) return -1;
      if (!aFuture && bFuture) return 1;
      // 未来同士: 早い順、過去同士: 新しい順
      return aFuture ? ta - tb : tb - ta;
    });
  }

  const memoLinks = linksByType.get("memo") ?? []; // 将来

  return NextResponse.json({
    project: {
      id: Number(p.id),
      name: p.name,
      color: p.color,
      description: p.description,
      archived: p.archived,
    },
    counts: {
      todo: { total: todoCount, by_state: todoByState },
      mail: mailRows.length,
      event: eventLinks.length,
      contact: contactRows.length,
      memo: memoLinks.length,
    },
    todos: todoRows.map((t) => ({
      id: Number(t.id),
      identifier: t.identifier,
      title: t.title,
      state: t.state,
      priority: t.priority,
      due_at: t.dueAt?.toISOString() ?? null,
      completed_at: t.completedAt?.toISOString() ?? null,
      linked_by: todoLinkedBy.get(String(t.id)) ?? "manual",
    })),
    mails: mailRows.map((m) => ({
      id: Number(m.id),
      subject: m.subject,
      from_name: m.fromName,
      from_email: m.fromEmail,
      received_at: m.receivedAt.toISOString(),
      starred: m.starredAt !== null,
      archived: m.archivedAt !== null,
      trashed: m.trashedAt !== null,
      linked_by: mailLinkedBy.get(String(m.id)) ?? "manual",
    })),
    events: eventRows,
    contacts: contactRows.map((c) => ({
      id: Number(c.id),
      name: c.name,
      kana: c.kana,
      company: c.company,
      role: c.role,
      linked_by: contactLinkedBy.get(String(c.id)) ?? "manual",
    })),
  });
}
