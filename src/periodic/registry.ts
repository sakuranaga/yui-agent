/**
 * 有効な periodic module の明示一覧。
 * 新しいモジュールを追加する時は、ここに 1 行 import + 配列に push するだけ。
 *
 * specialists/registry.ts と同じ pattern。auto-discover ではなく明示登録なので、
 * Next.js bundle で確実に解決され、誤って misplaced ファイルが動く事故もない。
 */
import type { PeriodicModule } from "./types";
import calendarCheck from "./calendar-check";
import diaryWrite from "./diary-write";
import newsFetch from "./news-fetch";
import morningCheck from "./morning-check";
import memoryDecay from "./memory-decay";
import memoryCleanup from "./memory-cleanup";
import mailPoll from "./mail-poll";
import profileSnapshot from "./profile-snapshot";
import reminderDispatch from "./reminder-dispatch";
import toolExecCleanup from "./tool-exec-cleanup";
import eventsOutboxCleanup from "./events-outbox-cleanup";

export const PERIODIC_MODULES: PeriodicModule[] = [
  calendarCheck,
  diaryWrite,
  newsFetch,
  morningCheck,
  memoryDecay,
  memoryCleanup,
  mailPoll,
  profileSnapshot,
  reminderDispatch,
  toolExecCleanup,
  eventsOutboxCleanup,
  // 将来:
  // todoDigest,     // 期限近い todos / state 滞留 todos の通知
];

export function listEnabled(): PeriodicModule[] {
  return PERIODIC_MODULES.filter((m) => m.enabled);
}
