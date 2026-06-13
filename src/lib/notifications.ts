/**
 * 通知 (お便り) DB アクセス層 + dispatchNotification (= 統一発火 IF)。
 *
 * v2 設計:
 * - 全 dispatcher の入口を `dispatchNotification` に集約 (= toast / 履歴 / rule 判定)
 * - 旧 `saveNotification` は `insertNotificationRow` にリネーム + 内部関数化
 * - music / schedule のみ speak を専用 fire 経路で投げる (= skipAutoSpeak: true で重複防止)
 *
 * 設計: docs/notification-system.md §4
 */
import { db } from "@/db/client";
import { notifications, type Notification, type NewNotification } from "@/db/schema";
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import { pushToSession } from "@/lib/jobs/events";
import { getEffectiveState, type UserState } from "@/lib/activity";
import { getRule, type EventKind, type Importance } from "@/lib/notification-settings";

/**
 * EventKind を re-export (= notifications.kind に使う型と統一)。
 * v1 の NotificationKind は廃止、EventKind を single source of truth に。
 */
export type { EventKind } from "@/lib/notification-settings";

export type NotificationImportance = "high" | "normal" | "low" | "silent";

export type DispatchInput = {
  sessionId: string;
  kind: EventKind;
  importance?: Importance;     // 省略時は rule.importance
  title: string;
  preview?: string;
  bodyMd?: string;
  payload?: Record<string, unknown>;
  refTable?: string;
  refId?: number;
  /**
   * speak fire で読み上げる固定テキスト。
   * 省略時は title + preview のドライ表記にフォールバック。
   * music / schedule のように動的 speak を別経路で投げる場合は省略 + skipAutoSpeak:true。
   */
  speakText?: string;
  /**
   * Discord に転送する時の本文。Web の speakText とは別管理。
   * 省略時は speakText を使う。両方無ければ Discord 転送は沈黙。
   */
  discordText?: string;
  /**
   * 内部で抑制したい場合の flag。news throttle / sleep mode 中等。
   * true なら mode 判定をスキップして toast=false, speak=false で履歴のみ残す。
   */
  suppressed?: boolean;
  /**
   * speak fire を別経路で持つ event (= music / schedule) は重複防止のため true に。
   * dispatchNotification 側の speak 出力 (yui_message push + overlay tee) が抑制される。
   * toast / 履歴 / Discord 転送には影響しない。
   */
  skipAutoSpeak?: boolean;
  /**
   * Discord 転送を抑止する。複数 active session へ broadcast する時、各 session 呼び出しで
   * 多重転送しないよう true にし、代表 1 回だけ別途転送する (= dispatchNotificationToActiveSessions)。
   */
  skipDiscordForward?: boolean;
  /**
   * state/policy に関わらず Discord 転送を強制する。離席 (active session ゼロ) 時に
   * MCP notify を確実に Discord で届けるために使う。suppressed 時は対象外。
   */
  forceDiscord?: boolean;
};

export type DispatchResult = {
  notificationId: number | null;
  toastFired: boolean;
  speakFired: boolean;
  discordForwarded: boolean;
};

/**
 * 通知を統一 IF で dispatch する。
 *
 * フロー (= 設計 §4.2):
 * 1. insertNotificationRow で DB 永続化 (= silent でも履歴は残す)
 * 2. getRule + getEffectiveState で toast / speak / discord を判定
 * 3. matrixState 正規化: private → focus 扱い
 * 4. toast=true なら pushToSession(notification SSE)
 * 5. speak=true && !skipAutoSpeak なら pushToSession(yui_message) + overlay tee
 * 6. Discord 転送 (focus / private は完全沈黙)
 *
 * 失敗時は throw せず warn のみ (= fire-and-forget 安全)。
 */
export async function dispatchNotification(
  input: DispatchInput
): Promise<DispatchResult> {
  const result: DispatchResult = {
    notificationId: null,
    toastFired: false,
    speakFired: false,
    discordForwarded: false,
  };
  try {
    const rule = await getRule(input.kind);
    const importance = (input.importance ?? rule.importance) as NotificationImportance;

    // Step 1: DB insert
    const row = await insertNotificationRow({
      sessionId: input.sessionId,
      kind: input.kind,
      importance,
      title: input.title,
      preview: input.preview,
      bodyMd: input.bodyMd,
      payload: input.payload,
      refTable: input.refTable,
      refId: input.refId,
    });
    if (!row) return result;
    result.notificationId = Number(row.id);

    // Step 2: state 取得 + 正規化 (= private は focus 扱い、設計 §8.1)
    const rawState = await getEffectiveState(input.sessionId);
    const matrixState: "online" | "away" | "focus" =
      rawState === "private" ? "focus" : rawState;

    // Step 3: mode 判定
    let toast: boolean;
    let speak: boolean;
    if (input.suppressed) {
      toast = false;
      speak = false;
    } else {
      if (matrixState === "online") {
        toast = rule.toastOnline;
        speak = rule.speakOnline;
      } else if (matrixState === "away") {
        toast = rule.toastAway;
        speak = rule.speakAway;
      } else {
        toast = rule.toastFocus;
        speak = rule.speakFocus;
      }
    }
    if (input.skipAutoSpeak) speak = false;

    // Step 4: Discord 転送判定 (focus / private / suppressed は完全沈黙)
    // suppressed=true (= sleep / throttle 等で意図的に抑制) のときは Discord にも
    // 漏らさない。toast / speak を出さない決定と Discord 配信は同じ意図 (= 静かに) と扱う。
    let forwardToDiscord = false;
    if (input.suppressed || input.skipDiscordForward) {
      forwardToDiscord = false;
    } else if (input.forceDiscord) {
      forwardToDiscord = true; // 離席時の MCP notify 等、state/policy を無視して確実に届ける
    } else if (rawState !== "focus" && rawState !== "private") {
      if (rule.discordPolicy === "always") forwardToDiscord = true;
      else if (rule.discordPolicy === "away_only" && rawState === "away") forwardToDiscord = true;
    }

    // Step 5: toast push (= SSE notification event)
    const forDiscord = input.discordText ?? input.speakText;
    const eventPayload = {
      type: "notification" as const,
      id: Number(row.id),
      kind: row.kind,
      importance,
      title: row.title,
      preview: row.preview ?? "",
      speakText: forDiscord,
      forwardToDiscord,
    };
    if (toast) {
      pushToSession(input.sessionId, eventPayload);
      result.toastFired = true;
    }

    // Step 6: speak push (= yui_message event + overlay tee)
    if (speak) {
      const text =
        input.speakText && input.speakText.trim().length > 0
          ? input.speakText
          : input.preview
            ? `${input.title}。${input.preview}`
            : input.title;
      pushToSession(input.sessionId, {
        type: "yui_message",
        jobId: Date.now(),
        text,
        emotion: "neutral",
      });
      result.speakFired = true;
      // overlay tee: リロード生存させるため Valkey overlay にも書く (= raw_messages に
      // 書かれない / プライベートモード時の発話との区別のため kind=ephemeral)
      void (async () => {
        try {
          const { appendOverlay } = await import("@/lib/conversation-overlay");
          await appendOverlay(input.sessionId, {
            role: "assistant",
            content: text,
            kind: "ephemeral",
            source: "notification",
          });
        } catch (e) {
          console.warn("[notifications] overlay tee failed:", e);
        }
      })();
    }

    // Step 7: Discord 転送 (= 別 session に push)
    if (forwardToDiscord) {
      const botSid = process.env.DISCORD_SESSION_ID;
      if (botSid && botSid !== input.sessionId) {
        pushToSession(botSid, eventPayload);
        result.discordForwarded = true;
      }
    }
  } catch (e) {
    console.warn("[notifications] dispatch failed:", e);
  }
  return result;
}

/**
 * 特定 session に紐づかない通知 (= MCP notify 等) を active な **Web** session に配信する。
 *
 * - active Web session あり: 各 session に dispatchNotification (toast/speak/履歴を各画面に)。
 *   Discord 多重転送を防ぐため、**先頭 1 件だけ** Discord 判定を有効にし (= rule + その session の
 *   state で away_only/always を 1 回評価)、残りは skipDiscordForward:true。
 * - active Web session ゼロ (= 離席): in-app は出せない (UI は current session しか読まない) ので、
 *   owner session に forceDiscord + skipAutoSpeak で 1 件 dispatch → Discord 転送 + 履歴 row (= log)
 *   のみ (toast push は購読者ゼロで no-op、speak/overlay は skipAutoSpeak で抑止)。
 *
 * 注: Discord bot 自身の SSE 購読 session (DISCORD_SESSION_ID) は Web session に数えない
 * (= これを含めると「離席」判定が常に潰れる)。
 *
 * 設計: docs/yui-mcp-server.md §6.3
 */
export async function dispatchNotificationToActiveSessions(
  input: Omit<DispatchInput, "sessionId">
): Promise<{ delivered: number; discordForwarded: boolean }> {
  const { activeSessionIds } = await import("@/lib/jobs/events");
  const botSid = process.env.DISCORD_SESSION_ID;
  const webSessions = activeSessionIds().filter((sid) => sid !== botSid);

  if (webSessions.length > 0) {
    let discordForwarded = false;
    for (let i = 0; i < webSessions.length; i++) {
      const r = await dispatchNotification({
        ...input,
        sessionId: webSessions[i],
        skipDiscordForward: i !== 0, // 先頭だけ Discord 判定を許可 (= rule を 1 回尊重)
      });
      if (r.discordForwarded) discordForwarded = true;
    }
    return { delivered: webSessions.length, discordForwarded };
  }

  // 離席: Discord + log のみ
  const { MCP_OWNER_SESSION_ID } = await import("@/lib/mcp/const");
  const r = await dispatchNotification({
    ...input,
    sessionId: MCP_OWNER_SESSION_ID,
    forceDiscord: true,
    skipAutoSpeak: true,
  });
  return { delivered: 0, discordForwarded: r.discordForwarded };
}

/**
 * 純粋な DB insert (= 副作用なし)。dispatchNotification からのみ呼ぶ前提で内部関数。
 *
 * v1 で export していた `saveNotification` は SSE / speak / Discord ロジックを内包して
 * いたため、dispatchNotification の step 1 でそのまま呼ぶと二重 dispatch になる。
 * v2 では persistence-only に切り出して、dispatchNotification 側に flow を移管した。
 */
type InsertInput = {
  sessionId: string;
  kind: EventKind;
  importance: NotificationImportance;
  title: string;
  preview?: string;
  bodyMd?: string;
  payload?: Record<string, unknown>;
  refTable?: string;
  refId?: number;
};

async function insertNotificationRow(
  input: InsertInput
): Promise<Notification | null> {
  try {
    const newRow: NewNotification = {
      sessionId: input.sessionId,
      kind: input.kind,
      importance: input.importance,
      title: input.title,
      preview: input.preview,
      bodyMd: input.bodyMd,
      payload: input.payload,
      refTable: input.refTable,
      refId: input.refId,
    };
    const [row] = await db.insert(notifications).values(newRow).returning();
    return row ?? null;
  } catch (e) {
    console.warn("[notifications] insert failed:", e);
    return null;
  }
}

/**
 * 一覧取得 (新しい順)。
 * dismissed_at IS NOT NULL のものは LogModal「お便り」タブ以外で除外する。
 */
export async function listNotifications(opts: {
  sessionId: string;
  unreadOnly?: boolean;
  includeDismissed?: boolean;
  limit?: number;
  before?: number;
}): Promise<Notification[]> {
  const conds = [eq(notifications.sessionId, opts.sessionId)];
  if (opts.unreadOnly) conds.push(isNull(notifications.seenAt));
  if (!opts.includeDismissed) conds.push(isNull(notifications.dismissedAt));
  if (opts.before) conds.push(lt(notifications.id, opts.before));

  return db
    .select()
    .from(notifications)
    .where(and(...conds))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(opts.limit ?? 50);
}

export async function getNotification(id: number): Promise<Notification | null> {
  const [row] = await db
    .select()
    .from(notifications)
    .where(eq(notifications.id, id))
    .limit(1);
  return row ?? null;
}

export async function markSeen(id: number): Promise<void> {
  await db
    .update(notifications)
    .set({ seenAt: new Date() })
    .where(and(eq(notifications.id, id), isNull(notifications.seenAt)));
}

export async function markAllSeen(sessionId: string): Promise<number> {
  const res = await db
    .update(notifications)
    .set({ seenAt: new Date() })
    .where(
      and(eq(notifications.sessionId, sessionId), isNull(notifications.seenAt))
    );
  return (res as unknown as { rowCount?: number }).rowCount ?? 0;
}

export async function markDismissed(id: number): Promise<void> {
  await db
    .update(notifications)
    .set({ dismissedAt: new Date() })
    .where(and(eq(notifications.id, id), isNull(notifications.dismissedAt)));
}

/**
 * 90 日経過した dismissed 通知を物理削除 (周期 cleanup 用)。
 */
export async function cleanupOldNotifications(): Promise<number> {
  const cutoff = new Date(Date.now() - 90 * 86_400_000);
  const res = await db
    .delete(notifications)
    .where(
      and(
        sql`${notifications.dismissedAt} IS NOT NULL`,
        lt(notifications.dismissedAt, cutoff)
      )
    );
  return (res as unknown as { rowCount?: number }).rowCount ?? 0;
}

// _UserState 参照のための re-export (= 型推論補助、削除候補)
export type { UserState };
