/**
 * GET /api/artifact-links/for?artifactType=&artifactId=
 *
 * ある artifact (今選択中のメール / TODO 等) について、出典 (sources) と
 * 派生 (targets) の両方向を、表示用情報 (件名 / タイトル / 名前 etc.) を
 * 内部結合して 1 レスポンスで返す。各 modal の detail pane 末尾に表示する
 * 「リンクされてる」パネル用。
 *
 * ## response
 *   {
 *     sources: Array<EnrichedLink>,    // この artifact がどこから来たか
 *     targets: Array<EnrichedLink>,    // この artifact から何が派生したか
 *   }
 *
 *   type EnrichedLink = {
 *     type: "mail" | "todo" | "contact" | "event" | "diary" | "memo",
 *     id: string,
 *     label: string,           // 表示文 (件名 / タイトル / 名前 etc.)
 *     sublabel?: string,       // 副情報 (差出人 / 状態 etc.)
 *     date?: string,           // 日付 ISO (受信日 / 期日 etc.)
 *     created_by: "intent" | "manual",
 *   }
 *
 * ## 新しい artifact_type を増やす時
 *   enrich() の switch に case 追加 → 該当テーブルから display 情報を join。
 *   events (gcal) は外部 API なのでこの endpoint では type+id のみ返し、
 *   client 側で gcal API から個別 fetch する想定 (今は Phase B スコープ外)。
 *
 * 設計: docs/roadmap.md §6.9 (intent endpoint Phase B — back-link UI)
 */
import { NextResponse, type NextRequest } from "next/server";
import { db } from "@/db/client";
import {
  artifactLinks,
  contacts,
  mailMessages,
  todos,
} from "@/db/schema";
import { and, eq, inArray } from "drizzle-orm";
import { getEvent, isGCalConfigured } from "@/lib/gcal";

export const dynamic = "force-dynamic";

type RawLink = { type: string; id: string; createdBy: string; createdAt: Date };

type EnrichedLink = {
  type: string;
  id: string;
  label: string;
  sublabel?: string;
  date?: string;
  created_by: string;
};

/** ID 列を type 別にまとめて bulk fetch → enriched に解決 */
async function enrich(links: RawLink[]): Promise<EnrichedLink[]> {
  if (links.length === 0) return [];
  const byType = new Map<string, string[]>();
  for (const l of links) {
    const arr = byType.get(l.type) ?? [];
    arr.push(l.id);
    byType.set(l.type, arr);
  }

  // todo
  const todoIds = (byType.get("todo") ?? [])
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  const todoMap = new Map<
    string,
    { title: string; state: string; identifier: string }
  >();
  if (todoIds.length > 0) {
    const rows = await db
      .select({
        id: todos.id,
        identifier: todos.identifier,
        title: todos.title,
        state: todos.state,
      })
      .from(todos)
      .where(inArray(todos.id, todoIds));
    for (const r of rows) {
      todoMap.set(String(r.id), {
        title: r.title,
        state: r.state,
        identifier: r.identifier,
      });
    }
  }

  // mail
  const mailIds = (byType.get("mail") ?? [])
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  const mailMap = new Map<
    string,
    {
      subject: string | null;
      fromName: string | null;
      fromEmail: string;
      receivedAt: Date;
    }
  >();
  if (mailIds.length > 0) {
    const rows = await db
      .select({
        id: mailMessages.id,
        subject: mailMessages.subject,
        fromName: mailMessages.fromName,
        fromEmail: mailMessages.fromEmail,
        receivedAt: mailMessages.receivedAt,
      })
      .from(mailMessages)
      .where(inArray(mailMessages.id, mailIds));
    for (const r of rows) {
      mailMap.set(String(r.id), {
        subject: r.subject,
        fromName: r.fromName,
        fromEmail: r.fromEmail,
        receivedAt: r.receivedAt,
      });
    }
  }

  // contact
  const contactIds = (byType.get("contact") ?? [])
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
  const contactMap = new Map<
    string,
    { name: string; company: string | null; role: string | null }
  >();
  if (contactIds.length > 0) {
    const rows = await db
      .select({
        id: contacts.id,
        name: contacts.name,
        company: contacts.company,
        role: contacts.role,
      })
      .from(contacts)
      .where(inArray(contacts.id, contactIds));
    for (const r of rows) {
      contactMap.set(String(r.id), {
        name: r.name,
        company: r.company,
        role: r.role,
      });
    }
  }

  // event は gcal API なので並列 fetch (削除済 / 404 は skip)
  const eventIds = byType.get("event") ?? [];
  const eventMap = new Map<
    string,
    { summary: string; startIso: string | null; allDay: boolean }
  >();
  if (eventIds.length > 0 && isGCalConfigured()) {
    const results = await Promise.all(
      eventIds.map(async (id) => {
        try {
          const e = await getEvent({ eventId: id });
          return {
            id,
            summary: e.summary ?? "(無題)",
            startIso: e.start?.dateTime ?? e.start?.date ?? null,
            allDay: !!e.start?.date,
          };
        } catch {
          return null;
        }
      })
    );
    for (const r of results) {
      if (r) eventMap.set(r.id, { summary: r.summary, startIso: r.startIso, allDay: r.allDay });
    }
  }

  // 結果を元の link 順に並べる
  return links
    .map<EnrichedLink | null>((l) => {
      switch (l.type) {
        case "todo": {
          const t = todoMap.get(l.id);
          if (!t) return null; // orphan
          return {
            type: "todo",
            id: l.id,
            label: `${t.identifier}「${t.title}」`,
            sublabel: t.state,
            created_by: l.createdBy,
          };
        }
        case "mail": {
          const m = mailMap.get(l.id);
          if (!m) return null;
          return {
            type: "mail",
            id: l.id,
            label: m.subject ?? "(件名なし)",
            sublabel: m.fromName ?? m.fromEmail,
            date: m.receivedAt.toISOString(),
            created_by: l.createdBy,
          };
        }
        case "contact": {
          const c = contactMap.get(l.id);
          if (!c) return null;
          return {
            type: "contact",
            id: l.id,
            label: c.name,
            sublabel: c.company ?? c.role ?? undefined,
            created_by: l.createdBy,
          };
        }
        case "event": {
          const e = eventMap.get(l.id);
          if (!e) return null;
          return {
            type: "event",
            id: l.id,
            label: e.summary,
            date: e.startIso ?? undefined,
            created_by: l.createdBy,
          };
        }
        // diary / memo は将来。
        default:
          return null;
      }
    })
    .filter((x): x is EnrichedLink => x !== null);
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const artifactType = sp.get("artifactType");
  const artifactId = sp.get("artifactId");
  if (!artifactType || !artifactId) {
    return NextResponse.json(
      { error: "artifactType + artifactId required" },
      { status: 400 }
    );
  }

  // 出典 (sources): この artifact を target として持つ link を引く
  const sourceRows = await db
    .select({
      type: artifactLinks.sourceType,
      id: artifactLinks.sourceId,
      createdBy: artifactLinks.createdBy,
      createdAt: artifactLinks.createdAt,
    })
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.targetType, artifactType as "todo" | "event" | "contact" | "memo"),
        eq(artifactLinks.targetId, artifactId)
      )
    );

  // 派生 (targets): この artifact を source として持つ link を引く
  const targetRows = await db
    .select({
      type: artifactLinks.targetType,
      id: artifactLinks.targetId,
      createdBy: artifactLinks.createdBy,
      createdAt: artifactLinks.createdAt,
    })
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.sourceType, artifactType as
          | "mail" | "event" | "todo" | "contact" | "diary"),
        eq(artifactLinks.sourceId, artifactId)
      )
    );

  const [sources, targets] = await Promise.all([
    enrich(sourceRows),
    enrich(targetRows),
  ]);

  return NextResponse.json({ sources, targets });
}
