/**
 * メール仕分け Phase 3: 自動アクション (学習ヒット + consent gate)。
 *
 * 設計: docs/mail-classification.md §5.6, §12 Phase 3
 *
 * mail-curate.ts の per-mail 判定後に呼ばれ、二重ゲート条件を満たした時のみ:
 *  - bucket=unneeded + score 低 → 自動ゴミ箱
 *  - bucket=important + 学習例の auto_todo=true → /api/intent 経路で TODO 作成
 *  - bucket=important + 学習例の auto_event=true → 同じく予定 (gcal) 作成
 *
 * 全ての自動アクションは:
 *  1. 学習ヒット (top-1 cosine sim ≥ 0.60)
 *  2. bucket_confidence ≥ 0.85
 *  3. 学習例の対応する consent フラグ (auto_todo / auto_event) — trash は consent 不要
 * を満たした時のみ走る。三重ゲートで誤動作を防ぐ。
 *
 * 失敗は warn ログだけで握り潰す (curate 全体は止めない)。
 */
import { db } from "@/db/client";
import { mailMessages, artifactLinks, todos } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { addTodo } from "@/lib/todos";
import { createEvent, isGCalConfigured } from "@/lib/gcal";
import { transformIntent } from "@/lib/intent-transform";
import type { MailArtifactData, ArtifactPayload } from "@/lib/artifact-payloads";
import type { TodoDraft, EventDraft } from "@/lib/intent-transform";

const CONFIDENCE_THRESHOLD = 0.85;
const TRASH_SCORE_MAX = 0.15; // bucket=unneeded でこれ以下なら自動ゴミ箱

export type AutoActionContext = {
  mailId: number;
  bucket: "important" | "needed" | "unneeded";
  bucketConfidence: number;
  bucketScore: number;
  /** 学習ヒット (top-1)。なければ null = アクション無し */
  topMatch: { sim: number; autoTodo: boolean; autoEvent: boolean } | null;
  /** intent transform に渡す source payload を組み立てる材料 */
  mail: {
    subject: string | null;
    fromName: string | null;
    fromEmail: string;
    toAddresses: string[] | null;
    bodyText: string | null;
    snippet: string | null;
    receivedAt: Date;
  };
};

/** mail-curate ループの per-mail 末尾で呼ばれるエントリポイント */
export async function maybeAutoAct(ctx: AutoActionContext): Promise<void> {
  // 学習ヒット無し or 確度不足 → 何もしない (受信箱にバッジ付きで残す)
  if (!ctx.topMatch) return;
  if (ctx.bucketConfidence < CONFIDENCE_THRESHOLD) return;

  if (ctx.bucket === "unneeded") {
    if (ctx.bucketScore <= TRASH_SCORE_MAX) {
      await autoTrash(ctx.mailId);
    }
    return;
  }

  if (ctx.bucket === "important") {
    if (ctx.topMatch.autoTodo) {
      await autoCreateTodo(ctx);
    }
    if (ctx.topMatch.autoEvent) {
      await autoCreateEvent(ctx);
    }
  }
}

async function autoTrash(mailId: number): Promise<void> {
  try {
    await db
      .update(mailMessages)
      .set({ trashedAt: new Date() })
      .where(eq(mailMessages.id, mailId));
    console.log(`[mail-auto-action] auto-trashed mail id=${mailId}`);
  } catch (e) {
    console.warn(`[mail-auto-action] auto-trash failed id=${mailId}:`, e);
  }
}

/** 既に同じ mail から auto-作成された target が居れば skip (idempotency) */
async function alreadyLinked(
  mailId: number,
  targetType: "todo" | "event"
): Promise<boolean> {
  const rows = await db
    .select()
    .from(artifactLinks)
    .where(
      and(
        eq(artifactLinks.sourceType, "mail"),
        eq(artifactLinks.sourceId, String(mailId)),
        eq(artifactLinks.targetType, targetType)
      )
    )
    .limit(1);
  return rows.length > 0;
}

function buildMailPayload(ctx: AutoActionContext): ArtifactPayload {
  const data: MailArtifactData = {
    subject: ctx.mail.subject ?? "(件名なし)",
    from: ctx.mail.fromName
      ? { name: ctx.mail.fromName, address: ctx.mail.fromEmail }
      : { address: ctx.mail.fromEmail },
    to: (ctx.mail.toAddresses ?? []).map((a) => ({ address: a })),
    bodySnippet: (ctx.mail.bodyText ?? ctx.mail.snippet ?? "").slice(0, 4000),
    receivedAt: ctx.mail.receivedAt.toISOString(),
  };
  return { type: "mail", data };
}

async function autoCreateTodo(ctx: AutoActionContext): Promise<void> {
  try {
    if (await alreadyLinked(ctx.mailId, "todo")) {
      console.log(`[mail-auto-action] todo already linked to mail id=${ctx.mailId}, skip`);
      return;
    }

    const { draft, warning } = await transformIntent(buildMailPayload(ctx), "todo");
    if (!draft || warning) {
      console.warn(
        `[mail-auto-action] intent transform failed for mail=${ctx.mailId} → todo, warning=${warning}`
      );
      return;
    }
    const todoDraft = draft as TodoDraft;

    const result = await addTodo({
      sessionId: "ui",
      title: todoDraft.title,
      note: todoDraft.note,
      tags: todoDraft.tags,
      dueAt: todoDraft.dueAt ? new Date(todoDraft.dueAt) : undefined,
      externalRef: `mail:${ctx.mailId}`,
      // 自動アクション = bypassDedup=false で、既存があれば既存を返す (重複作成しない)。
      // それでも artifact_link は張って traceability を保つ。
      bypassDedup: false,
    });

    await db
      .insert(artifactLinks)
      .values({
        sourceType: "mail",
        sourceId: String(ctx.mailId),
        targetType: "todo",
        targetId: String(result.todo.id),
        createdBy: "intent",
      })
      .onConflictDoNothing();

    console.log(
      `[mail-auto-action] auto-todo mail=${ctx.mailId} → ${result.todo.identifier} "${result.todo.title}"`
    );
  } catch (e) {
    console.warn(`[mail-auto-action] auto-todo failed mail=${ctx.mailId}:`, e);
  }
}

async function autoCreateEvent(ctx: AutoActionContext): Promise<void> {
  try {
    if (!isGCalConfigured()) {
      console.warn(`[mail-auto-action] auto-event requested but GCal not configured, skip`);
      return;
    }
    if (await alreadyLinked(ctx.mailId, "event")) {
      console.log(`[mail-auto-action] event already linked to mail id=${ctx.mailId}, skip`);
      return;
    }

    const { draft, warning } = await transformIntent(buildMailPayload(ctx), "event");
    if (!draft || warning) {
      console.warn(
        `[mail-auto-action] intent transform failed for mail=${ctx.mailId} → event, warning=${warning}`
      );
      return;
    }
    const evDraft = draft as EventDraft;
    if (!evDraft.startIso) {
      console.warn(`[mail-auto-action] event draft missing startIso, skip mail=${ctx.mailId}`);
      return;
    }

    // 終了時刻が無ければ 1 時間後に
    const startIso = evDraft.startIso;
    const endIso =
      evDraft.endIso ??
      new Date(new Date(startIso).getTime() + 60 * 60 * 1000).toISOString();

    const created = await createEvent({
      summary: evDraft.summary,
      description: evDraft.description,
      location: evDraft.location,
      start: { dateTime: startIso },
      end: { dateTime: endIso },
    });

    await db
      .insert(artifactLinks)
      .values({
        sourceType: "mail",
        sourceId: String(ctx.mailId),
        targetType: "event",
        targetId: created.id,
        createdBy: "intent",
      })
      .onConflictDoNothing();

    // 後で TODO の duedate と紐付ける用に SELECT で覗いておく (debug log)
    void todos;
    console.log(
      `[mail-auto-action] auto-event mail=${ctx.mailId} → ${created.id} "${evDraft.summary}" start=${startIso}`
    );
  } catch (e) {
    console.warn(`[mail-auto-action] auto-event failed mail=${ctx.mailId}:`, e);
  }
}
