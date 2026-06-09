/**
 * ユーザー状態 (オンライン / 離席 / 集中 / プライベート) のサーバ側 in-memory store。
 *
 * クライアント (useUserState) が /api/activity に POST してくる状態を保持し、
 * 通知振り分け (speak vs notify) や Discord 配信判定に使う。
 *
 * 1 ユーザー運用前提なので Redis 不要。Hot reload で初期化されても
 * クライアントが mount 時に再送するので問題なし。
 *
 * v2: 旧「夜間 22-7 JST 強制 away」ハードコードは廃止し、quiet_hours_settings
 * (UI 設定可、デフォルト OFF) に置換。詳細: docs/notification-system.md §8.2
 *
 * 設計: docs/notification-system.md §8
 */
import { isInQuietHours } from "@/lib/quiet-hours";

export type UserState = "online" | "away" | "focus" | "private";

type ActivityEntry = {
  state: UserState;
  lastActivityAt: number;
  updatedAt: number;
  /** 集中モードに入った時刻。離脱後の「集中中のお便り ○件」集計に使う。 */
  focusEnteredAt: number | null;
};

declare global {
  var __vroidActivityMap: Map<string, ActivityEntry> | undefined;
}

function getMap(): Map<string, ActivityEntry> {
  if (!globalThis.__vroidActivityMap) {
    globalThis.__vroidActivityMap = new Map();
  }
  return globalThis.__vroidActivityMap;
}

export type TransitionInfo = {
  exitedFocus: boolean;
  focusEnteredAt: number | null; // 集中解除時、いつから集中していたかを返す
};

export function setActivity(
  sessionId: string,
  state: UserState,
  lastActivityAt: number
): TransitionInfo {
  const map = getMap();
  const prev = map.get(sessionId);
  let focusEnteredAt = prev?.focusEnteredAt ?? null;
  let exitedFocus = false;
  if (state === "focus" && prev?.state !== "focus") {
    focusEnteredAt = Date.now();
  } else if (state !== "focus" && prev?.state === "focus") {
    exitedFocus = true;
    const enteredAt = focusEnteredAt;
    focusEnteredAt = null;
    map.set(sessionId, { state, lastActivityAt, updatedAt: Date.now(), focusEnteredAt: null });
    return { exitedFocus, focusEnteredAt: enteredAt };
  }
  map.set(sessionId, { state, lastActivityAt, updatedAt: Date.now(), focusEnteredAt });
  return { exitedFocus, focusEnteredAt };
}

/**
 * 実効状態を返す。
 * - 接続断 / heartbeat なし 60 秒以上 → away に降格 (focus / private は維持)
 * - サイレント時間帯 (= 設定 ON 時のみ) → away に降格 (focus / private は維持)
 * - sessionId が未知 → online (新規 session の最初の通知は届けたい)
 *
 * v2 で sync → async に変更 (= quiet_hours_settings の DB 参照のため)。
 * 呼出元は必ず await すること。await 漏らすと Promise の比較になり、
 * "private" 判定等が壊れる (= chat/route.ts:531 の `!== "private"` で常に true) ので
 * 厳重注意。
 */
export async function getEffectiveState(sessionId: string): Promise<UserState> {
  const entry = getMap().get(sessionId);
  if (!entry) return "online";

  let state = entry.state;
  const staleMs = Date.now() - entry.updatedAt;
  // focus / private は手動制御で、自動 stale / quiet hours の影響を受けない
  if (staleMs > 60_000 && state !== "focus" && state !== "private") {
    state = "away";
  }
  if (state !== "focus" && state !== "private") {
    if (await isInQuietHours()) {
      state = "away";
    }
  }
  return state;
}

export function getActivity(sessionId: string): ActivityEntry | null {
  return getMap().get(sessionId) ?? null;
}
