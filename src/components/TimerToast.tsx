"use client";

/**
 * タイマー / アラームのトースト。
 *
 * - 左下 (viewer 内、Report Panel と被らない位置) に常駐
 * - kind=timer: 残り時間カウントダウン (秒更新)
 * - kind=alarm: 時刻 + ラベル静的表示
 * - 発火後 30 秒で自動消滅
 * - × で cancel POST
 *
 * SSE で timer_created / timer_fired / timer_cancelled を受信して更新。
 * mount 時に /api/timers で active 一覧を取得 (リロード後の状態復元)。
 */
import { useCallback, useEffect, useMemo, useState } from "react";

type TimerKind = "timer" | "alarm";
type TimerStatus = "pending" | "fired";

type TimerItem = {
  id: number;
  kind: TimerKind;
  label: string | null;
  targetAt: string; // ISO
  status: TimerStatus;
  /** fired 時刻 (ms epoch)。30 秒後に自動消滅させるため */
  firedAtMs?: number;
};

type Props = {
  sessionId: string;
};

const FIRE_LIFETIME_MS = 30_000;

export default function TimerToast({ sessionId }: Props) {
  const [timers, setTimers] = useState<TimerItem[]>([]);
  // React 19 purity: Date.now() を render 中に呼ばないため lazy init。
  // 後段の setInterval が 1 秒ごとに setNow で更新する。
  const [now, setNow] = useState<number>(() => Date.now());

  // 初回 + sessionId 変化時: /api/timers で active を取得
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/timers?session=${encodeURIComponent(sessionId)}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          timers: Array<{
            id: number;
            kind: TimerKind;
            label: string | null;
            target_at: string;
          }>;
        };
        if (cancelled) return;
        setTimers(
          data.timers.map((t) => ({
            id: t.id,
            kind: t.kind,
            label: t.label,
            targetAt: t.target_at,
            status: "pending",
          }))
        );
      } catch (e) {
        console.warn("[TimerToast] initial load failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // SSE 経由のイベントは ChatPanel が dispatch する custom event を listen する
  // (ChatPanel が既に EventSource を持っているので二重 connect しない)
  useEffect(() => {
    function onCreated(e: Event) {
      const d = (e as CustomEvent).detail as {
        id: number;
        kind: TimerKind;
        label: string | null;
        targetAt: string;
      };
      setTimers((cur) => [
        ...cur.filter((t) => t.id !== d.id),
        { id: d.id, kind: d.kind, label: d.label, targetAt: d.targetAt, status: "pending" },
      ]);
    }
    function onFired(e: Event) {
      const d = (e as CustomEvent).detail as { id: number };
      setTimers((cur) =>
        cur.map((t) =>
          t.id === d.id ? { ...t, status: "fired", firedAtMs: Date.now() } : t
        )
      );
    }
    function onCancelled(e: Event) {
      const d = (e as CustomEvent).detail as { id: number };
      setTimers((cur) => cur.filter((t) => t.id !== d.id));
    }
    window.addEventListener("yui-timer-created", onCreated);
    window.addEventListener("yui-timer-fired", onFired);
    window.addEventListener("yui-timer-cancelled", onCancelled);
    return () => {
      window.removeEventListener("yui-timer-created", onCreated);
      window.removeEventListener("yui-timer-fired", onFired);
      window.removeEventListener("yui-timer-cancelled", onCancelled);
    };
  }, []);

  // 1 秒更新 (カウントダウン用 + 発火後消滅判定)
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  // 発火後 FIRE_LIFETIME_MS 経過で自動消滅 (= 表示から除外)。
  // 旧実装は useEffect 内で setTimers(cur => cur.filter(...)) して physical GC してたが、
  // 公式 anti-pattern #1 (derived state in effect) なので useMemo で派生 view にする。
  // 元の state `timers` には fired entry が残るが、せいぜい数件で memory 影響は無視可。
  const visibleTimers = useMemo(
    () =>
      timers.filter(
        (t) =>
          t.status === "pending" ||
          (t.firedAtMs && now - t.firedAtMs < FIRE_LIFETIME_MS),
      ),
    [timers, now],
  );

  // 「左へスワイプ消滅」アニメ用: leaving 中の id を持つ。アニメ終わりに本除去。
  const [leavingIds, setLeavingIds] = useState<Set<number>>(new Set());

  const handleCancel = useCallback(async (id: number) => {
    // まず leaving フラグだけ立てて CSS アニメ発火 → 300ms 後に DOM 除去 & DELETE
    setLeavingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setTimeout(() => {
      setTimers((cur) => cur.filter((t) => t.id !== id));
      setLeavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 300);
    try {
      await fetch(`/api/timers/${id}`, { method: "DELETE" });
    } catch (e) {
      console.warn("[TimerToast] cancel failed:", e);
    }
  }, []);

  if (visibleTimers.length === 0) return null;

  return (
    <div className="timer-toast-stack" aria-label="タイマー / アラーム">
      {visibleTimers.map((t) => (
        <TimerCard
          key={t.id}
          item={t}
          now={now}
          leaving={leavingIds.has(t.id)}
          onCancel={handleCancel}
        />
      ))}
    </div>
  );
}

function TimerCard({
  item,
  now,
  leaving,
  onCancel,
}: {
  item: TimerItem;
  now: number;
  leaving: boolean;
  onCancel: (id: number) => void;
}) {
  const target = new Date(item.targetAt);
  const targetMs = target.getTime();
  const fired = item.status === "fired";
  const isTimer = item.kind === "timer";

  let displayMain: string;
  let displaySub: string;

  if (isTimer && !fired) {
    const remainMs = Math.max(0, targetMs - now);
    displayMain = formatRemaining(remainMs);
    displaySub = item.label ?? "タイマー";
  } else if (!isTimer && !fired) {
    displayMain = formatClock(target);
    displaySub = item.label ?? "アラーム";
  } else {
    // fired
    displayMain = item.label ?? (isTimer ? "タイマー" : "アラーム");
    displaySub = "時間です";
  }

  return (
    <div
      className={`timer-toast${fired ? " timer-toast-fired" : ""}${leaving ? " timer-toast-leaving" : ""}`}
      role="status"
    >
      <div className="timer-toast-icon">
        {fired ? (
          <BellIcon />
        ) : isTimer ? (
          <ClockIcon />
        ) : (
          <CalendarIcon />
        )}
      </div>
      <div className="timer-toast-body">
        <div className="timer-toast-main">{displayMain}</div>
        <div className="timer-toast-sub">{displaySub}</div>
      </div>
      <button
        type="button"
        className="timer-toast-close"
        onClick={() => onCancel(item.id)}
        aria-label="取り消し"
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
    </div>
  );
}

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function formatClock(d: Date): string {
  const h = d.getHours();
  const m = d.getMinutes();
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
}

function ClockIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <polyline points="12 6 12 12 16 14" />
    </svg>
  );
}

function CalendarIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
      <line x1="16" y1="2" x2="16" y2="6" />
      <line x1="8" y1="2" x2="8" y2="6" />
      <line x1="3" y1="10" x2="21" y2="10" />
    </svg>
  );
}

function BellIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
      <path d="M12 2a7 7 0 00-7 7v3.5L3 16h18l-2-3.5V9a7 7 0 00-7-7zm0 20a3 3 0 003-3H9a3 3 0 003 3z" />
    </svg>
  );
}
