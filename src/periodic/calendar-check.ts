/**
 * Calendar check (5 min interval)
 *
 * 役割: 5 分後に始まる予定があれば notification dispatch + Yui に予告発話させる。
 *
 * v2:
 * - 終日 event (= e.start.date のみ) を filter で除外 (= v1 で 0 時前に「3 分後」と
 *   告げるバグの原因)
 * - dispatchNotification 経由で toast / 履歴 / Discord 配信を統一化
 * - speak は既存の `fire: { prompt }` 経路を維持 (= 動的予告文を Yui に作らせるため)
 * - 設定参照: rule.speakFor(state) が false なら speak fire skip
 *
 * 設計: docs/notification-system.md §4.4 (schedule 行) + §5
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import { listEvents, type CalEvent } from "@/lib/gcal";
import { loadCurrentToken } from "@/lib/google-oauth";
import { dispatchNotification } from "@/lib/notifications";
import { getRule } from "@/lib/notification-settings";
import { getEffectiveState } from "@/lib/activity";

function eventStartMs(e: CalEvent): number {
  if (e.start.dateTime) return new Date(e.start.dateTime).getTime();
  // 終日 event (e.start.date のみ) は 5 分前通知すべきでない → NaN を返して除外
  // (= "今日は終日 X" を 0 時前に「3 分後」と告げる v1 バグの修正)
  return NaN;
}

const NOTIFY_MINUTES_BEFORE = 5;
const WINDOW_HALF_MINUTES = 2.5;
const FIRED_TTL_MS = 24 * 60 * 60 * 1000;

type Snapshot = {
  /** key = event id, value = fired at (ms epoch) */
  firedEventIds: Record<string, number>;
};

const calendarCheck: PeriodicModule = {
  id: "calendar-check",
  enabled: true,
  schedule: { kind: "interval", everyMs: 5 * 60_000 },
  run: async (ctx: PeriodicContext): Promise<PeriodicResult> => {
    // 1) GCal 認証無しなら静かに skip
    const tok = await loadCurrentToken().catch(() => null);
    if (!tok || !tok.scopes.some((s) => s.endsWith("/calendar.readonly"))) {
      return { skip: true, reason: "no gcal token" };
    }

    // 2) 直近 10 分以内の予定を取得 (window: now+2.5min 〜 now+7.5min)
    const now = Date.now();
    const windowStart = now + (NOTIFY_MINUTES_BEFORE - WINDOW_HALF_MINUTES) * 60_000;
    const windowEnd = now + (NOTIFY_MINUTES_BEFORE + WINDOW_HALF_MINUTES) * 60_000;

    let events: CalEvent[];
    try {
      events = await listEvents({
        timeMin: new Date(now).toISOString(),
        timeMax: new Date(now + 15 * 60_000).toISOString(),
        maxResults: 20,
      });
    } catch (e) {
      return { skip: true, reason: `gcal fetch failed: ${e instanceof Error ? e.message : String(e)}` };
    }

    const matching = events.filter((e) => {
      if (e.status === "cancelled") return false;
      const startMs = eventStartMs(e);
      // 終日 event は eventStartMs が NaN を返すので Number.isFinite で自動除外される
      return Number.isFinite(startMs) && startMs >= windowStart && startMs <= windowEnd;
    });
    if (matching.length === 0) return { skip: true, reason: "no event in window" };

    // 3) 既に通知済みのは除外 (snapshot.firedEventIds)
    const prev = (ctx.lastSnapshot as Snapshot | null) ?? { firedEventIds: {} };
    const fresh: Record<string, number> = {};
    for (const [k, v] of Object.entries(prev.firedEventIds)) {
      if (now - v < FIRED_TTL_MS) fresh[k] = v;
    }
    const unNotified = matching.filter((e) => !(e.id in fresh));
    if (unNotified.length === 0) {
      return { skip: true, reason: "all in window already notified", snapshot: { firedEventIds: fresh } };
    }

    // 4) toast / 履歴 / Discord 配信を dispatchNotification 経由で投げる。
    //    speak は下の fire:{prompt} で動的予告文を Yui に作らせるので skipAutoSpeak: true。
    //    dispatch が失敗した (= notificationId === null) 場合は snapshot を進めず、
    //    次 tick で再試行できるようにする (= 重要通知は取りこぼし禁止)。
    const top = unNotified[0];
    const topStartMin = Math.round((eventStartMs(top) - now) / 60_000);
    const topTitle = top.summary ?? "(タイトル無し)";
    const othersCount = unNotified.length - 1;
    const dispatchTitle =
      othersCount > 0
        ? `${topStartMin} 分後に予定: ${topTitle} (ほか ${othersCount} 件)`
        : `${topStartMin} 分後に予定: ${topTitle}`;
    const dispatchResult = await dispatchNotification({
      sessionId: ctx.sessionId,
      kind: "schedule",
      importance: "high",
      title: dispatchTitle,
      preview: undefined,
      payload: {
        event_id: top.id,
        start_iso: top.start.dateTime,
        others_count: othersCount,
      },
      refTable: "calendar_events", // 仮想 (= 実テーブル無し、event_id で identify)
      // refId は数値しか持てない、calendar event id は string なので payload に格納
      skipAutoSpeak: true,
    });
    if (dispatchResult.notificationId === null) {
      // DB insert / SSE 失敗 → 次 tick で再試行 (snapshot 進めない)
      return {
        skip: true,
        reason: "dispatch failed, will retry next tick",
        snapshot: { firedEventIds: fresh },
      };
    }

    // 5) speak 判定: rule.speakFor(state) が false なら fire skip。
    let shouldSpeak = false;
    try {
      const rule = await getRule("schedule");
      const rawState = await getEffectiveState(ctx.sessionId);
      const matrixState: "online" | "away" | "focus" =
        rawState === "private" ? "focus" : rawState;
      shouldSpeak =
        matrixState === "online"
          ? rule.speakOnline
          : matrixState === "away"
            ? rule.speakAway
            : rule.speakFocus;
    } catch (e) {
      console.warn("[calendar-check] rule lookup failed:", e);
    }

    // 6) snapshot 更新 — fired set にこの ID を追加 (speak の有無にかかわらず、
    //    同じ event を次 tick で再 dispatch しないように)
    const next: Snapshot = {
      firedEventIds: { ...fresh, ...Object.fromEntries(unNotified.map((u) => [u.id, now])) },
    };

    if (!shouldSpeak) {
      return {
        skip: true,
        reason: `${unNotified.length} event(s) dispatched (speak skipped by rule)`,
        snapshot: next,
      };
    }

    // 7) speak fire 用の動的予告文
    const others = othersCount > 0 ? ` (ほか ${othersCount} 件)` : "";
    const prompt = [
      `[system trigger: calendar-check]`,
      `${topStartMin}分後に予定「${topTitle}」が始まります${others}。`,
      `ご主人様に丁寧に、短く 1-2 文で予告してください。`,
      `(これは Yui からの自発的な声かけです。ユーザー発話ではありません)`,
    ].join("\n");

    return { fire: { prompt }, reason: `notify ${unNotified.length} event(s) (speak)`, snapshot: next };
  },
};

export default calendarCheck;
