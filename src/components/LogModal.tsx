"use client";

/**
 * ログ Modal (IconBar の LOG ボタンから開く)。
 *
 * タブ:
 *   - 会話: raw_messages を session 横断で新しい順、ワード検索 + 期間指定 + 無限スクロール
 *   - システム: llm_events を新しい順、期間指定 + 無限スクロール + clear
 *   - お便り: notifications テーブル (Phase A 以降で実装、未実装時はプレースホルダ)
 *   - ブリーフィング: morning_briefs を日別新しい順、markdown 詳細表示
 *
 * 無限スクロール: 最下部に近づいたら次ページ fetch (IntersectionObserver)。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";
import { playOpenChime } from "@/lib/sfx";

type Tab = "conv" | "sys" | "notify" | "brief";

type Brief = {
  id: number;
  entryDate: string;
  generatedAt: string;
  markdown: string;
};

type NotifyItem = {
  id: number;
  kind: string;
  importance: "high" | "normal" | "low" | "silent";
  title: string;
  preview: string;
  bodyMd: string | null;
  createdAt: string;
  seenAt: string | null;
  dismissedAt: string | null;
};

const NOTIFY_KIND_LABEL: Record<string, string> = {
  morning_brief: "ブリーフ",
  news: "ニュース",
  diary: "日記",
  mail: "メール",
  health: "体調",
  timer: "タイマー",
  custom: "お便り",
};

type ConvMsg = {
  id: number;
  sessionId: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  ts: number;
};

type LlmEvent =
  | {
      type: "call";
      ts: number;
      role: string;
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
      durationMs: number;
      retries: number;
      traceId?: string;
    }
  | {
      type: "trace";
      ts: number;
      traceId: string;
      calls: number;
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd: number;
      llmMs: number;
      wallMs: number;
    };

type Props = {
  open: boolean;
  onClose: () => void;
};

const PAGE_SIZE = 50;

export default function LogModal({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>("conv");

  // Esc で閉じる + body scroll lock
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const { mounted, closing } = useModalTransition(open);
  if (!mounted) return null;

  return (
    <div
      className={`log-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`log-modal ${closing ? "modal-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="log-modal-title">
        <header className="log-modal-header">
          <h1 id="log-modal-title">ログ</h1>
          <button type="button" className="log-modal-close" onClick={onClose} aria-label="閉じる">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <line x1="6" y1="6" x2="18" y2="18" />
              <line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </header>
        <div className="log-modal-tabs" role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "conv"}
            className={`log-modal-tab ${tab === "conv" ? "active" : ""}`}
            onClick={() => setTab("conv")}
          >
            会話
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "notify"}
            className={`log-modal-tab ${tab === "notify" ? "active" : ""}`}
            onClick={() => setTab("notify")}
          >
            お便り
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "brief"}
            className={`log-modal-tab ${tab === "brief" ? "active" : ""}`}
            onClick={() => setTab("brief")}
          >
            ブリーフィング
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "sys"}
            className={`log-modal-tab ${tab === "sys" ? "active" : ""}`}
            onClick={() => setTab("sys")}
          >
            システム
          </button>
        </div>
        <div className="log-modal-body">
          {tab === "conv" && <ConversationTab />}
          {tab === "sys" && <SystemTab />}
          {tab === "notify" && <NotifyTab onClose={onClose} />}
          {tab === "brief" && <BriefTab />}
        </div>
      </div>
    </div>
  );
}

// --- 共通: 日付入力 → ms ---
function dateInputToMs(s: string, endOfDay = false): number | undefined {
  if (!s) return undefined;
  const d = new Date(s + (endOfDay ? "T23:59:59.999" : "T00:00:00.000"));
  if (Number.isNaN(d.getTime())) return undefined;
  return d.getTime();
}

function fmtTs(ts: number): string {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// --- 会話タブ ---
function ConversationTab() {
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [messages, setMessages] = useState<ConvMsg[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const id = setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const fromMs = useMemo(() => dateInputToMs(from), [from]);
  const toMs = useMemo(() => dateInputToMs(to, true), [to]);

  // フィルタが変わったらリセット (anti-pattern #4: key prop で remount にする follow-up)。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setMessages([]);
    setHasMore(true);
  }, [qDebounced, fromMs, toMs]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadMore = useCallback(
    async (before?: number) => {
      if (loading) return;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        if (qDebounced) params.set("q", qDebounced);
        if (fromMs) params.set("from", String(fromMs));
        if (toMs) params.set("to", String(toMs));
        if (before) params.set("before", String(before));
        const res = await fetch(`/api/logs/conversation?${params.toString()}`);
        if (!res.ok) {
          setHasMore(false);
          return;
        }
        const data = (await res.json()) as { messages: ConvMsg[] };
        const next = data.messages ?? [];
        if (next.length === 0) {
          setHasMore(false);
        } else {
          setMessages((prev) => (before ? [...prev, ...next] : next));
          if (next.length < PAGE_SIZE) setHasMore(false);
        }
      } catch (e) {
        console.warn("conv load failed:", e);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [loading, qDebounced, fromMs, toMs]
  );

  // 初回 + フィルタ変更後の初回読み込み
  useEffect(() => {
    if (messages.length === 0 && hasMore && !loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pagination on-empty fetch
      void loadMore(undefined);
    }
  }, [messages.length, hasMore, loading, loadMore]);

  // 無限スクロール: sentinel 監視
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && messages.length > 0) {
          void loadMore(messages[messages.length - 1].ts);
        }
      },
      { root: null, rootMargin: "200px", threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, messages, loadMore]);

  return (
    <div className="log-tab-pane">
      <div className="log-filter-row">
        <input
          name="log-search"
          type="text"
          placeholder="ワード検索"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          className="log-filter-input"
        />
        <label className="log-filter-date-label">
          From
          <input name="log-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="log-filter-date-label">
          To
          <input name="log-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
      </div>
      <div className="log-list">
        {messages.length === 0 && !loading && (
          <div className="log-empty">該当する会話がありません。</div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`log-conv-item log-conv-${m.role}`}>
            <div className="log-conv-meta">
              <span className="log-conv-role">{m.role === "user" ? "ご主人様" : "結衣"}</span>
              <span className="log-conv-ts">{fmtTs(m.ts)}</span>
              <span className="log-conv-sid">…{m.sessionId.slice(-6)}</span>
            </div>
            <div className="log-conv-content">{m.content}</div>
          </div>
        ))}
        <div ref={sentinelRef} />
        {loading && <div className="log-loading">読み込み中…</div>}
        {!hasMore && messages.length > 0 && (
          <div className="log-end">これ以上ありません</div>
        )}
      </div>
    </div>
  );
}

// --- システムタブ ---
function SystemTab() {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [events, setEvents] = useState<LlmEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [size, setSize] = useState(0);
  const [clearing, setClearing] = useState(false);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  const fromMs = useMemo(() => dateInputToMs(from), [from]);
  const toMs = useMemo(() => dateInputToMs(to, true), [to]);

  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setEvents([]);
    setHasMore(true);
  }, [fromMs, toMs]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadMore = useCallback(
    async (before?: number) => {
      if (loading) return;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        if (fromMs) params.set("from", String(fromMs));
        if (toMs) params.set("to", String(toMs));
        if (before) params.set("before", String(before));
        const res = await fetch(`/api/logs/system?${params.toString()}`);
        if (!res.ok) {
          setHasMore(false);
          return;
        }
        const data = (await res.json()) as { events: LlmEvent[]; totalCount: number };
        setSize(data.totalCount ?? 0);
        const next = data.events ?? [];
        if (next.length === 0) {
          setHasMore(false);
        } else {
          setEvents((prev) => (before ? [...prev, ...next] : next));
          if (next.length < PAGE_SIZE) setHasMore(false);
        }
      } catch (e) {
        console.warn("sys load failed:", e);
        setHasMore(false);
      } finally {
        setLoading(false);
      }
    },
    [loading, fromMs, toMs]
  );

  useEffect(() => {
    if (events.length === 0 && hasMore && !loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pagination on-empty fetch
      void loadMore(undefined);
    }
  }, [events.length, hasMore, loading, loadMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && events.length > 0) {
          void loadMore(events[events.length - 1].ts);
        }
      },
      { root: null, rootMargin: "200px", threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, events, loadMore]);

  const clearAll = useCallback(async () => {
    if (!confirm("システムログを全削除します。よろしいですか?")) return;
    setClearing(true);
    try {
      const res = await fetch("/api/logs/system", { method: "DELETE" });
      if (res.ok) {
        setEvents([]);
        setHasMore(true);
        setSize(0);
      }
    } finally {
      setClearing(false);
    }
  }, []);

  return (
    <div className="log-tab-pane">
      <div className="log-filter-row">
        <label className="log-filter-date-label">
          From
          <input name="log-system-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="log-filter-date-label">
          To
          <input name="log-system-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <span className="log-filter-spacer" />
        <span className="log-filter-meta">{size.toLocaleString()} 件</span>
        <button
          type="button"
          className="log-clear-btn"
          onClick={clearAll}
          disabled={clearing}
        >
          {clearing ? "削除中…" : "クリア"}
        </button>
      </div>
      <div className="log-list">
        {events.length === 0 && !loading && (
          <div className="log-empty">ログがありません。</div>
        )}
        {events.map((e, i) => (
          <div key={`${e.ts}-${i}`} className={`log-sys-item log-sys-${e.type}`}>
            <div className="log-sys-meta">
              <span className="log-sys-ts">{fmtTs(e.ts)}</span>
              {e.type === "call" ? (
                <>
                  <span className="log-sys-kind">CALL</span>
                  <span className="log-sys-role">{e.role}</span>
                  <span className="log-sys-model">{e.model}</span>
                </>
              ) : (
                <>
                  <span className="log-sys-kind log-sys-kind-trace">TRACE</span>
                  <span className="log-sys-trace">{e.traceId}</span>
                </>
              )}
              <span className="log-sys-cost">${e.costUsd.toFixed(5)}</span>
              <span className="log-sys-dur">
                {e.type === "call" ? `${e.durationMs}ms` : `${e.wallMs}ms (LLM ${e.llmMs}ms)`}
              </span>
            </div>
            <div className="log-sys-tokens">
              in={e.inputTokens} out={e.outputTokens} cache_r={e.cacheReadTokens}{" "}
              cache_w={e.cacheWriteTokens}
              {e.type === "trace" && ` calls=${e.calls}`}
              {e.type === "call" && e.traceId && ` trace=${e.traceId}`}
              {e.type === "call" && e.retries > 0 && ` retries=${e.retries}`}
            </div>
          </div>
        ))}
        <div ref={sentinelRef} />
        {loading && <div className="log-loading">読み込み中…</div>}
        {!hasMore && events.length > 0 && (
          <div className="log-end">これ以上ありません</div>
        )}
      </div>
    </div>
  );
}

// --- お便りタブ (通知履歴、90 日分) ---
function NotifyTab({ onClose }: { onClose: () => void }) {
  const [items, setItems] = useState<NotifyItem[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      // localStorage から session を引く
      const sid =
        typeof window !== "undefined"
          ? window.localStorage.getItem("vroid-chat-session-id")
          : null;
      if (!sid) {
        setItems([]);
        return;
      }
      const res = await fetch(
        `/api/notifications?session=${encodeURIComponent(sid)}&include_dismissed=1&limit=100`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = (await res.json()) as { notifications: NotifyItem[] };
      setItems(data.notifications ?? []);
    } catch (e) {
      console.warn("[notify-tab] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回 mount で notifications を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();
  }, [reload]);

  const replay = async (id: number) => {
    playOpenChime();
    try {
      await fetch(`/api/notifications/${id}/replay`, { method: "POST" });
      // ステータス変化を反映
      setItems((cur) =>
        cur.map((x) =>
          x.id === id ? { ...x, seenAt: new Date().toISOString(), dismissedAt: new Date().toISOString() } : x
        )
      );
      // ReportPanel に展開された内容を見せるためモーダルを閉じる
      onClose();
    } catch (e) {
      console.warn("[notify-tab] replay failed:", e);
    }
  };

  const statusLabel = (n: NotifyItem) => {
    if (n.seenAt) return "読了";
    if (n.dismissedAt) return "未読(×)";
    return "未読";
  };

  return (
    <div className="log-tab-pane">
      <div className="log-list">
        {loading && items.length === 0 && (
          <div className="log-loading">読み込み中…</div>
        )}
        {!loading && items.length === 0 && (
          <div className="log-empty">お便りの履歴はまだありません。</div>
        )}
        {items.map((n) => (
          <div key={n.id} className="log-notify-item">
            <div className="log-notify-head">
              <span className="log-notify-ts">{fmtTs(new Date(n.createdAt).getTime())}</span>
              <span className={`log-notify-kind log-notify-kind-${n.kind}`}>
                {NOTIFY_KIND_LABEL[n.kind] ?? n.kind}
              </span>
              <span className={`log-notify-status status-${n.seenAt ? "read" : n.dismissedAt ? "skipped" : "unread"}`}>
                {statusLabel(n)}
              </span>
              <button
                type="button"
                className="log-notify-replay"
                onClick={() => void replay(n.id)}
                title={n.seenAt ? "再読" : "読む"}
              >
                {n.seenAt ? "再読" : "読む"}
              </button>
            </div>
            <div className="log-notify-title">{n.title}</div>
            {n.preview && <div className="log-notify-preview">{n.preview}</div>}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- ブリーフィングタブ ---
function BriefTab() {
  const [briefs, setBriefs] = useState<Brief[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/logs/briefs?limit=60");
        if (!res.ok) return;
        const data = (await res.json()) as { briefs: Brief[] };
        const list = data.briefs ?? [];
        setBriefs(list);
        if (list.length > 0) setSelectedId(list[0].id);
      } catch (e) {
        console.warn("[brief] load failed:", e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const selected = briefs.find((b) => b.id === selectedId) ?? null;

  const fmtBriefDate = (iso: string) => {
    const d = new Date(iso);
    const fmt = new Intl.DateTimeFormat("ja-JP", {
      timeZone: "Asia/Tokyo",
      year: "numeric",
      month: "long",
      day: "numeric",
      weekday: "short",
    });
    return fmt.format(d);
  };

  return (
    <div className="log-tab-pane log-brief-pane">
      <div className="log-brief-body">
        <div className="log-brief-sidebar">
          {loading && <div className="log-loading">読み込み中…</div>}
          {!loading && briefs.length === 0 && (
            <div className="log-empty">ブリーフィング履歴がありません</div>
          )}
          {briefs.map((b) => (
            <button
              key={b.id}
              type="button"
              className={`log-brief-item ${selectedId === b.id ? "active" : ""}`}
              onClick={() => setSelectedId(b.id)}
            >
              {fmtBriefDate(b.entryDate)}
            </button>
          ))}
        </div>
        <div className="log-brief-content">
          {selected ? (
            <>
              <h3 className="log-brief-title">{fmtBriefDate(selected.entryDate)}</h3>
              <div className="log-brief-meta">
                生成: {fmtTs(new Date(selected.generatedAt).getTime())}
              </div>
              <pre className="log-brief-text">{selected.markdown}</pre>
            </>
          ) : (
            !loading && (
              <div className="log-empty">左の日付を選択してください</div>
            )
          )}
        </div>
      </div>
    </div>
  );
}
