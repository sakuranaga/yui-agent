"use client";

/**
 * 通知 (お便り) トースト。TimerToast と同じ画面左下 stack に並ぶ。
 *
 * - 初回 mount: /api/notifications?unread_only=1 で既存の未読・未 dismiss を表示
 * - SSE 経由 `yui-notification` イベントで新着を stack の先頭に追加
 * - X クリック → dismiss API + leaving アニメ → DOM 除去
 * - 本体クリック → replay (Phase C で実装。現状は dismiss と同じ)
 * - importance 別の効果音 (Phase C で実装、ファイル未配置なら skip)
 * - 集中モード時のフィルタは Phase D (現状は全部出す)
 *
 * 設計: docs/notification-system.md §9
 */
import { useCallback, useEffect, useState } from "react";
import { playOpenChime } from "@/lib/sfx";

type NotificationItem = {
  id: number;
  kind: string;
  importance: "high" | "normal" | "low" | "silent";
  title: string;
  preview: string;
};


type Props = {
  sessionId: string;
};

const MAX_VISIBLE = 5;

export default function NotificationToast({ sessionId }: Props) {
  const [items, setItems] = useState<NotificationItem[]>([]);
  const [leavingIds, setLeavingIds] = useState<Set<number>>(new Set());

  // 注: 集中モード切替時の retroactive クリアは廃止。
  // mode 振り分けは「これから来る通知」に対してサーバ側で判定するので、
  // 既にトーストに乗っている分は state 変化に関係なくそのまま残す方が自然。

  // 初回 + sessionId 変化時: 未読・未 dismiss を取得
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch(
          `/api/notifications?session=${encodeURIComponent(sessionId)}&unread_only=1&limit=${MAX_VISIBLE}`,
          { cache: "no-store" }
        );
        if (!res.ok) return;
        const data = (await res.json()) as { notifications: NotificationItem[] };
        if (cancelled) return;
        setItems(data.notifications ?? []);
      } catch (e) {
        console.warn("[NotificationToast] initial load failed:", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  // SSE 経由 (ChatPanel が dispatch する yui-notification)。
  // mode = silent のときはサーバ側で SSE 送信自体がスキップされるので、ここに来た時点で表示確定。
  useEffect(() => {
    function onNotification(e: Event) {
      const d = (e as CustomEvent<NotificationItem>).detail;
      setItems((cur) => {
        if (cur.some((x) => x.id === d.id)) return cur;
        return [d, ...cur].slice(0, MAX_VISIBLE);
      });
    }
    window.addEventListener("yui-notification", onNotification);
    return () => {
      window.removeEventListener("yui-notification", onNotification);
    };
  }, []);

  const dismissOne = useCallback(async (id: number) => {
    setLeavingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setTimeout(() => {
      setItems((cur) => cur.filter((x) => x.id !== id));
      setLeavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 300);
    try {
      await fetch(`/api/notifications/${id}/dismiss`, { method: "POST" });
    } catch (e) {
      console.warn("[NotificationToast] dismiss failed:", e);
    }
  }, []);

  // 本体クリック: replay 発動。
  //   server 側で seen + dismissed をセットし、ReportPanel に bodyMd を push。
  //   開いたのはご主人様なので Yui の声は出さず、軽い chime を鳴らすだけにする。
  const handleClick = useCallback(async (id: number) => {
    playOpenChime();
    setLeavingIds((prev) => {
      const next = new Set(prev);
      next.add(id);
      return next;
    });
    setTimeout(() => {
      setItems((cur) => cur.filter((x) => x.id !== id));
      setLeavingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }, 300);
    try {
      await fetch(`/api/notifications/${id}/replay`, { method: "POST" });
    } catch (e) {
      console.warn("[NotificationToast] replay failed:", e);
    }
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="notification-toast-stack" aria-label="結衣からのお便り">
      {items.map((n) => (
        <NotificationCard
          key={n.id}
          item={n}
          leaving={leavingIds.has(n.id)}
          onClick={() => handleClick(n.id)}
          onDismiss={() => dismissOne(n.id)}
        />
      ))}
    </div>
  );
}

function NotificationCard({
  item,
  leaving,
  onClick,
  onDismiss,
}: {
  item: NotificationItem;
  leaving: boolean;
  onClick: () => void;
  onDismiss: () => void;
}) {
  return (
    <button
      type="button"
      className={`notification-toast${leaving ? " notification-toast-leaving" : ""} notification-toast-${item.importance}`}
      onClick={onClick}
    >
      <span className="notification-toast-icon" aria-hidden="true">
        <KindIcon kind={item.kind} />
      </span>
      <span className="notification-toast-body">
        <span className="notification-toast-title">{item.title}</span>
        {item.preview && (
          <span className="notification-toast-preview">{item.preview}</span>
        )}
      </span>
      <span
        className="notification-toast-close"
        role="button"
        aria-label="閉じる"
        tabIndex={0}
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            e.stopPropagation();
            onDismiss();
          }
        }}
      >
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </span>
    </button>
  );
}

/** 種別ごとの line SVG アイコン (絵文字は使わない、設計 §9) */
function KindIcon({ kind }: { kind: string }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 18,
    height: 18,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (kind) {
    case "morning_brief":
      return (
        <svg {...common}>
          <circle cx="12" cy="13" r="4" />
          <line x1="12" y1="3" x2="12" y2="6" />
          <line x1="4" y1="21" x2="20" y2="21" />
          <line x1="4.5" y1="9" x2="6.5" y2="11" />
          <line x1="19.5" y1="9" x2="17.5" y2="11" />
        </svg>
      );
    case "news":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="1" />
          <line x1="7" y1="9" x2="17" y2="9" />
          <line x1="7" y1="13" x2="13" y2="13" />
          <line x1="7" y1="16" x2="17" y2="16" />
        </svg>
      );
    case "diary":
      return (
        <svg {...common}>
          <path d="M4 4h7v16H4z" />
          <path d="M13 4h7v16h-7z" />
          <line x1="11" y1="4" x2="13" y2="4" />
        </svg>
      );
    case "mail":
    case "mail_other":
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="14" rx="2" />
          <polyline points="3 7 12 13 21 7" />
        </svg>
      );
    case "mail_important":
      // 封筒 + ★ マークで「重要」を明示
      return (
        <svg {...common}>
          <rect x="3" y="7" width="18" height="13" rx="2" />
          <polyline points="3 9 12 15 21 9" />
          <polygon points="18 2 19.2 4.5 22 4.9 20 7 20.4 9.8 18 8.5 15.6 9.8 16 7 14 4.9 16.8 4.5" fill="currentColor" stroke="none" />
        </svg>
      );
    case "schedule":
      // カレンダー
      return (
        <svg {...common}>
          <rect x="3" y="5" width="18" height="16" rx="2" />
          <line x1="3" y1="9" x2="21" y2="9" />
          <line x1="8" y1="3" x2="8" y2="6" />
          <line x1="16" y1="3" x2="16" y2="6" />
        </svg>
      );
    case "music":
      // 音符
      return (
        <svg {...common}>
          <path d="M9 17V5l11-2v12" />
          <circle cx="6" cy="17" r="3" />
          <circle cx="17" cy="15" r="3" />
        </svg>
      );
    case "reminder":
      // ベル
      return (
        <svg {...common}>
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10 21a2 2 0 0 0 4 0" />
        </svg>
      );
    case "health":
      return (
        <svg {...common}>
          <polyline points="3 12 7 12 9 7 11 17 13 10 15 14 17 12 21 12" />
        </svg>
      );
    case "timer":
      return (
        <svg {...common}>
          <path d="M12 2a8 8 0 0 1 6 13.3l1.5 1.5M5 18l1.5-1.5A8 8 0 0 1 12 2" />
          <line x1="12" y1="8" x2="12" y2="13" />
          <line x1="12" y1="13" x2="15" y2="15" />
        </svg>
      );
    default:
      // custom: 結衣の手紙風 = 封筒 + 結びリボン
      return (
        <svg {...common}>
          <rect x="3" y="6" width="18" height="13" rx="2" />
          <polyline points="3 8 12 14 21 8" />
        </svg>
      );
  }
}
