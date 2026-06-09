/**
 * 朝のブリーフィング素材を集めて prompt 文字列に組み立てる。
 *
 * morning-check periodic から fire 時に呼ばれ、結果は /api/chat に source=cron で
 * 投入されて Yui (Sonnet) が結衣の口調で返す。
 *
 * 集める素材:
 *  - 今日の予定 (gcal、visible 全 cal 横断)
 *  - 今日 / 明日期限の未完了 todos
 *  - 過去 24h の主要ニュース 3 件
 *  - 未読メール (Gmail scope があれば)
 *
 * 各収集は失敗しても止めない (graceful degradation)。
 */
import { listEvents, type CalEvent } from "@/lib/gcal";
import { listTodos } from "@/lib/todos";
import { listArticles as listNewsArticles } from "@/lib/news";
import { isGmailConfigured, searchMessageSummaries, type GmailMessageSummary } from "@/lib/gmail";
import { loadCurrentToken } from "@/lib/google-oauth";
import { db } from "@/db/client";
import { mailMessages } from "@/db/schema";
import { and, eq, gte, isNull, desc } from "drizzle-orm";

const JST = "Asia/Tokyo";

function jstYmd(d: Date): string {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: JST,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function jstWeekday(d: Date): string {
  return new Intl.DateTimeFormat("ja-JP", { timeZone: JST, weekday: "short" }).format(d);
}

function jstTimeRange(e: CalEvent): string {
  const fmt = (iso?: string, date?: string): string => {
    if (date) return date;
    if (!iso) return "";
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    return new Intl.DateTimeFormat("ja-JP", {
      timeZone: JST,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(d);
  };
  const start = fmt(e.start.dateTime, e.start.date);
  const end = fmt(e.end.dateTime, e.end.date);
  if (e.start.date) return "終日";
  return `${start}-${end}`;
}

export type MorningMaterial = {
  schedule: CalEvent[];
  todos: Array<{ identifier: string; title: string; dueAt: Date | null; project: string | null }>;
  news: Array<{ source: string; title: string; published: Date }>;
  mail: GmailMessageSummary[]; // legacy: 直近 24h 未読 (Gmail 直接)
  importantMail: Array<{
    id: number;
    fromName: string | null;
    fromEmail: string;
    subject: string | null;
    reason: string | null;
  }>; // bucket=important で直近 24h に分類されたもの (docs/mail-classification.md §9)
  collected: { schedule: boolean; todos: boolean; news: boolean; mail: boolean; importantMail: boolean };
};

export async function collectMorningMaterial(now: Date = new Date()): Promise<MorningMaterial> {
  const todayYmd = jstYmd(now);
  const startOfToday = new Date(`${todayYmd}T00:00:00+09:00`);
  const endOfTomorrow = new Date(startOfToday.getTime() + 48 * 60 * 60 * 1000);
  const endOfToday = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
  const twentyFourHoursAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  const out: MorningMaterial = {
    schedule: [],
    todos: [],
    news: [],
    mail: [],
    importantMail: [],
    collected: { schedule: false, todos: false, news: false, mail: false, importantMail: false },
  };

  // 1) Schedule (今日のみ)
  try {
    const events = await listEvents({
      timeMin: startOfToday.toISOString(),
      timeMax: endOfToday.toISOString(),
      maxResults: 20,
    });
    out.schedule = events.filter((e) => e.status !== "cancelled");
    out.collected.schedule = true;
  } catch (e) {
    console.warn("[morning-brief] schedule fetch failed:", e instanceof Error ? e.message : e);
  }

  // 2) Todos (今日+明日期限の未完了)
  try {
    const rows = await listTodos({
      states: ["backlog", "in_progress", "blocked"],
      dueBefore: endOfTomorrow,
      limit: 10,
    });
    out.todos = rows
      .filter((r) => r.todo.dueAt !== null)
      .map((r) => ({
        identifier: r.todo.identifier,
        title: r.todo.title,
        dueAt: r.todo.dueAt,
        project: r.projectName,
      }));
    out.collected.todos = true;
  } catch (e) {
    console.warn("[morning-brief] todos fetch failed:", e instanceof Error ? e.message : e);
  }

  // 3) News (過去 24h の新着、pinned 除外、3 件)
  try {
    const articles = await listNewsArticles({ limit: 30 });
    out.news = articles
      .filter((a) => a.publishedAt >= twentyFourHoursAgo)
      .slice(0, 3)
      .map((a) => ({
        source: a.sourceName,
        title: a.title,
        published: a.publishedAt,
      }));
    out.collected.news = true;
  } catch (e) {
    console.warn("[morning-brief] news fetch failed:", e instanceof Error ? e.message : e);
  }

  // 4) 重要メール (bucket=important で直近 24h 分類分、ゴミ箱外、最大 5 件)
  //    docs/mail-classification.md §9
  try {
    const rows = await db
      .select({
        id: mailMessages.id,
        fromName: mailMessages.fromName,
        fromEmail: mailMessages.fromEmail,
        subject: mailMessages.subject,
        bucketReason: mailMessages.bucketReason,
      })
      .from(mailMessages)
      .where(
        and(
          eq(mailMessages.bucket, "important"),
          gte(mailMessages.classifiedAt, twentyFourHoursAgo),
          isNull(mailMessages.trashedAt)
        )
      )
      .orderBy(desc(mailMessages.classifiedAt))
      .limit(5);
    out.importantMail = rows.map((r) => ({
      id: Number(r.id),
      fromName: r.fromName,
      fromEmail: r.fromEmail,
      subject: r.subject,
      reason: r.bucketReason,
    }));
    out.collected.importantMail = true;
  } catch (e) {
    console.warn("[morning-brief] important-mail fetch failed:", e instanceof Error ? e.message : e);
  }

  // 5) Mail (Gmail scope があれば。直近 24h の未読、5 件)。bucket と独立の legacy 経路
  try {
    const token = await loadCurrentToken();
    if (isGmailConfigured() && token) {
      const summaries = await searchMessageSummaries({
        q: "is:unread newer_than:1d",
        maxResults: 5,
      });
      out.mail = summaries;
      out.collected.mail = true;
    }
  } catch (e) {
    console.warn("[morning-brief] mail fetch failed:", e instanceof Error ? e.message : e);
  }

  return out;
}

/**
 * ReportPanel 用の markdown ブリーフ。Yui の voice とは別系統で、人間がじっくり読む側。
 * 同じ素材から見やすく整形 (link 付き、太字、日付明記)。
 */
export function buildMorningBriefMarkdown(m: MorningMaterial, now: Date = new Date()): string {
  const todayYmd = jstYmd(now);
  const weekday = jstWeekday(now);
  const lines: string[] = [`## ${todayYmd} (${weekday}) 朝のブリーフィング`, ""];

  if (m.schedule.length > 0) {
    lines.push("### 本日の予定", "");
    for (const e of m.schedule) {
      const time = jstTimeRange(e);
      const title = e.summary ?? "(no title)";
      const cal = e.calendarSummary ? ` _(${e.calendarSummary})_` : "";
      const loc = e.location ? ` @ ${e.location}` : "";
      lines.push(`- **${time}** ${title}${loc}${cal}`);
    }
    lines.push("");
  } else if (m.collected.schedule) {
    lines.push("### 本日の予定", "", "_予定なし、お休みの一日ですね。_", "");
  }

  if (m.todos.length > 0) {
    lines.push("### 期限近 todos (今日〜明日)", "");
    for (const t of m.todos) {
      const due = t.dueAt
        ? new Intl.DateTimeFormat("ja-JP", {
            timeZone: JST,
            month: "numeric",
            day: "numeric",
          }).format(t.dueAt)
        : "?";
      const proj = t.project ? ` _(${t.project})_` : "";
      lines.push(`- \`${t.identifier}\` ${t.title}${proj} — 期限 **${due}**`);
    }
    lines.push("");
  }

  if (m.importantMail.length > 0) {
    lines.push("### 重要メール (直近 24h)", "");
    for (const msg of m.importantMail) {
      const from = msg.fromName ?? msg.fromEmail;
      const subject = msg.subject ?? "(件名なし)";
      const reason = msg.reason ? ` _(${msg.reason})_` : "";
      lines.push(`- **${from}**: ${subject}${reason}`);
    }
    lines.push("");
  }

  if (m.news.length > 0) {
    lines.push("### 主要ニュース (直近 24h)", "");
    for (const n of m.news) {
      lines.push(`- **[${n.source}]** ${n.title}`);
    }
    lines.push("");
  }

  if (m.mail.length > 0) {
    lines.push("### 未読メール (直近 24h)", "");
    for (const msg of m.mail) {
      const from = msg.from ?? "(unknown)";
      const subject = msg.subject ?? "(no subject)";
      lines.push(`- **${from}**: ${subject}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function buildMorningBriefPrompt(m: MorningMaterial, now: Date = new Date()): string {
  const todayYmd = jstYmd(now);
  const weekday = jstWeekday(now);

  const lines: string[] = [
    "[system trigger: morning-check]",
    `今朝のブリーフィングをお願いします。日付: ${todayYmd} (${weekday})。`,
    "下記の素材を踏まえて、結衣の口調で 3-5 文の朝の挨拶 + 要点まとめを返してください。",
    "重要度の高いものを優先し、無理にすべて触れる必要はありません。",
    "(これは Yui からの自発的な声かけです。ユーザー発話ではありません)",
    "",
  ];

  // Schedule
  if (m.schedule.length > 0) {
    lines.push("【本日の予定】");
    for (const e of m.schedule) {
      const time = jstTimeRange(e);
      const title = e.summary ?? "(no title)";
      const cal = e.calendarSummary ? ` [${e.calendarSummary}]` : "";
      lines.push(`- ${time} ${title}${cal}`);
    }
    lines.push("");
  } else if (m.collected.schedule) {
    lines.push("【本日の予定】 なし");
    lines.push("");
  }

  // Todos
  if (m.todos.length > 0) {
    lines.push("【期限近 todos (今日〜明日)】");
    for (const t of m.todos) {
      const due = t.dueAt
        ? new Intl.DateTimeFormat("ja-JP", {
            timeZone: JST,
            month: "numeric",
            day: "numeric",
          }).format(t.dueAt)
        : "?";
      const proj = t.project ? ` (${t.project})` : "";
      lines.push(`- ${t.identifier} ${t.title}${proj} / 期限 ${due}`);
    }
    lines.push("");
  }

  // Important Mail (bucket=important)
  if (m.importantMail.length > 0) {
    lines.push("【重要メール (直近 24h、結衣の仕分け済)】");
    for (const msg of m.importantMail) {
      const from = msg.fromName ?? msg.fromEmail;
      const subject = msg.subject ?? "(件名なし)";
      const reason = msg.reason ? ` — ${msg.reason}` : "";
      lines.push(`- ${from}: ${subject}${reason}`);
    }
    lines.push("");
  }

  // News
  if (m.news.length > 0) {
    lines.push("【主要ニュース (直近 24h)】");
    for (const n of m.news) {
      lines.push(`- [${n.source}] ${n.title}`);
    }
    lines.push("");
  }

  // Mail (legacy Gmail 未読、bucket と独立)
  if (m.mail.length > 0) {
    lines.push("【未読メール (直近 24h)】");
    for (const msg of m.mail) {
      const from = msg.from ?? "(unknown)";
      const subject = msg.subject ?? "(no subject)";
      lines.push(`- ${from}: ${subject}`);
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}
