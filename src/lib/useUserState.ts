/**
 * ユーザー状態 (オンライン / 離席 / 集中) を一元管理する hook。
 *
 * - localStorage で永続化
 * - 30 分操作なしで自動「離席」、操作で自動「オンライン」復帰
 * - 「集中」は手動切替のみ (自動移行も自動解除もなし)
 * - サーバへ /api/activity で同期 (mount + state 変化 + 30 秒間隔)
 * - SecretaryCard のドット色とも連動 (window 経由で event 発火)
 * - 他コンポーネント (SleepOverlay 等) からは setUserStateGlobal で同じ
 *   event を発火 → 本 hook が listen して内部 state に反映
 *
 * 設計: docs/notification-system.md §4
 */
import { useCallback, useEffect, useRef, useState } from "react";

export type UserState = "online" | "away" | "focus" | "private";

const STORAGE_KEY = "vroid-user-state";
const STATE_EVENT = "yui-user-state";
const AWAY_THRESHOLD_MS = 30 * 60_000; // 30 分
const ACTIVITY_PING_INTERVAL_MS = 30_000; // 30 秒ごとに /api/activity 同期

/**
 * Hook の外側 (Sleep セッション開始/終了など) からユーザー状態を切り替えるための helper。
 * localStorage に書いて event を投げると、useUserState の listener が拾って内部 state
 * を同期する。SSR ガード付き。
 */
export function setUserStateGlobal(s: UserState): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_KEY, s);
  } catch {
    /* noop */
  }
  window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: { state: s } }));
}

export function useUserState(sessionId: string | undefined): {
  state: UserState;
  setState: (s: UserState) => void;
} {
  const [state, setStateInternal] = useState<UserState>(() => {
    if (typeof window === "undefined") return "online";
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === "online" || raw === "away" || raw === "focus" || raw === "private") return raw;
    return "online";
  });
  // React 19 purity: Date.now() を render 中に呼ばない。mount 時に effect で初期化。
  // useEffect は宣言順で fire するので、後続 effect (activity listener / sync) は
  // 0 ではなく正しい初期値を見れる。
  const lastActivityRef = useRef<number>(0);
  const stateRef = useRef<UserState>(state);

  useEffect(() => {
    lastActivityRef.current = Date.now();
  }, []);

  // state 変化時に stateRef を最新値に同期 (render 中の ref 書き換えは React 19 で禁止)。
  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  const setState = useCallback((s: UserState) => {
    setStateInternal(s);
    try {
      window.localStorage.setItem(STORAGE_KEY, s);
    } catch {}
    // SecretaryCard 等が拾うイベント
    window.dispatchEvent(new CustomEvent(STATE_EVENT, { detail: { state: s } }));
  }, []);

  // 外部 (SleepOverlay 等) からの state 切替 event を listen して同期。
  // 自分自身が dispatch した event も来るが、state が既に同じなら no-op。
  useEffect(() => {
    const onExternal = (ev: Event) => {
      const detail = (ev as CustomEvent<{ state?: UserState }>).detail;
      const next = detail?.state;
      if (
        (next === "online" || next === "away" || next === "focus" || next === "private") &&
        next !== stateRef.current
      ) {
        setStateInternal(next);
      }
    };
    window.addEventListener(STATE_EVENT, onExternal as EventListener);
    return () => window.removeEventListener(STATE_EVENT, onExternal as EventListener);
  }, []);

  // 操作を検出: mousemove / mousedown / keydown / focus / visibilitychange
  useEffect(() => {
    const onActivity = () => {
      lastActivityRef.current = Date.now();
      // 離席中に操作があったらオンラインに自動復帰 (集中は手動なので戻さない)
      if (stateRef.current === "away") setState("online");
    };
    const onVisibility = () => {
      if (!document.hidden) onActivity();
    };
    window.addEventListener("mousemove", onActivity);
    window.addEventListener("mousedown", onActivity);
    window.addEventListener("keydown", onActivity);
    window.addEventListener("focus", onActivity);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("mousemove", onActivity);
      window.removeEventListener("mousedown", onActivity);
      window.removeEventListener("keydown", onActivity);
      window.removeEventListener("focus", onActivity);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [setState]);

  // 30 分操作なしで離席に降格 (集中 / プライベートは影響受けない — 手動制御専用)
  useEffect(() => {
    const id = setInterval(() => {
      if (stateRef.current !== "online") return;
      if (Date.now() - lastActivityRef.current >= AWAY_THRESHOLD_MS) {
        setState("away");
      }
    }, 60_000);
    return () => clearInterval(id);
  }, [setState]);

  // サーバへ同期: mount + state 変化 + 30 秒間隔
  useEffect(() => {
    if (!sessionId) return;
    const sync = () => {
      // eslint-disable-next-line no-restricted-syntax -- client-side hook、相対 URL で自 origin の /api/* を叩く (= ブラウザの fetch、SSRF 無関係)
      void fetch("/api/activity", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          state: stateRef.current,
          lastActivityAt: lastActivityRef.current,
        }),
      }).catch(() => {});
    };
    sync();
    const id = setInterval(sync, ACTIVITY_PING_INTERVAL_MS);
    return () => clearInterval(id);
  }, [sessionId, state]);

  return { state, setState };
}
