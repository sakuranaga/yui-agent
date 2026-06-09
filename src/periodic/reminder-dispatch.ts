/**
 * Reminders dispatcher: 1 分間隔で due な reminder を取り出し、通知マトリックスに従って
 * 振り分ける。
 *
 * v2:
 * - 全 reminder を dispatchNotification 経由に統一 (= toast / 履歴 / Discord 配信)
 * - rule.speak* が true の reminder のみ別途 speakBucket に積み、`fire: { prompt }` で
 *   buildFirePrompt の動的セリフを Yui に喋らせる
 * - dispatchNotification 側は speak rules でも skipAutoSpeak: true で重複防止
 *
 * 設計: docs/notification-system.md §4.4 (reminder 行)
 */
import type { PeriodicModule, PeriodicContext, PeriodicResult } from "./types";
import {
  getDueReminders,
  markFired,
  buildFirePrompt,
  reminderEventKind,
} from "@/lib/reminders";
import { dispatchNotification } from "@/lib/notifications";
import { getRule } from "@/lib/notification-settings";
import { getEffectiveState } from "@/lib/activity";
import type { Reminder } from "@/db/schema";

const reminderDispatch: PeriodicModule = {
  id: "reminder-dispatch",
  enabled: true,
  schedule: { kind: "interval", everyMs: 60_000 },
  run: async (ctx: PeriodicContext): Promise<PeriodicResult> => {
    const now = new Date();
    const due = await getDueReminders(now);
    if (due.length === 0) return { skip: true };

    const rawState = await getEffectiveState(ctx.sessionId);
    const matrixState: "online" | "away" | "focus" =
      rawState === "private" ? "focus" : rawState;
    const eventKind = reminderEventKind("custom"); // 統合済 = "reminder" を返すだけ
    let shouldSpeak = false;
    try {
      const rule = await getRule(eventKind);
      shouldSpeak =
        matrixState === "online"
          ? rule.speakOnline
          : matrixState === "away"
            ? rule.speakAway
            : rule.speakFocus;
    } catch (e) {
      console.warn(`[reminder-dispatch] rule lookup failed:`, e);
    }

    const speakBucket: Reminder[] = [];

    for (const reminder of due) {
      // 二重発火防止: markFired を先に呼んで atomic に claim する。
      // claim 失敗 (= 他 tick が先に取った) なら dispatch も speak も一切しない。
      let claimed = false;
      try {
        claimed = await markFired(reminder, now);
      } catch (e) {
        console.warn(`[reminder-dispatch] markFired failed for ${reminder.id}:`, e);
        continue;
      }
      if (!claimed) {
        console.log(`[reminder-dispatch] skip ${reminder.id} (claimed by overlap tick)`);
        continue;
      }

      // 全件 dispatchNotification 経由 (= toast / 履歴 / Discord 配信)。
      // speak fire は別経路で動的 prompt を投げるので、skipAutoSpeak: true で重複防止。
      try {
        await dispatchNotification({
          sessionId: ctx.sessionId,
          kind: eventKind,
          importance: "normal",
          title: reminder.title,
          preview: reminder.title,
          bodyMd: reminder.title,
          refTable: "reminders",
          refId: reminder.id,
          skipAutoSpeak: true,
        });
      } catch (e) {
        console.warn(`[reminder-dispatch] dispatch failed for ${reminder.id}:`, e);
      }

      if (shouldSpeak) {
        speakBucket.push(reminder);
      }
    }

    if (speakBucket.length === 0) {
      return {
        skip: true,
        reason: `processed ${due.length} reminder(s) via dispatch only`,
      };
    }

    return {
      fire: { prompt: buildFirePrompt(speakBucket) },
      reason: `${speakBucket.length} reminder(s) via speak`,
    };
  },
};

export default reminderDispatch;
