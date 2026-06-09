"use client";

/**
 * ニュース一覧モーダル。
 *
 * 上部: source 別タブ (All / NHK / 朝日 / ... + 「保存済み」「ソース管理」)
 * 下部: 記事リスト (pinned 先頭、その後新着順)
 * 各記事: タイトル + 概要 + ソース名 + 公開日時 + ★ (pin/unpin) + 外部リンク
 *
 * RSS は 1 時間毎 periodic で自動取得済。このモーダルは DB から読むだけ。
 */
import { useCallback, useEffect, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";

type Article = {
  id: number;
  source_id: number;
  source_name: string;
  title: string;
  link: string | null;
  summary: string | null;
  published_at: string;
  pinned: boolean;
  pinned_at: string | null;
};

type Source = {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
};

type Tab = { kind: "all" } | { kind: "pinned" } | { kind: "source"; id: number };

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function NewsModal({ open, onClose }: Props) {
  const [sources, setSources] = useState<Source[]>([]);
  const [articles, setArticles] = useState<Article[]>([]);
  const [tab, setTab] = useState<Tab>({ kind: "all" });
  const [loading, setLoading] = useState(false);

  const loadSources = useCallback(async () => {
    try {
      const res = await fetch("/api/news/sources");
      if (!res.ok) return;
      const d = (await res.json()) as { sources: Source[] };
      setSources(d.sources ?? []);
    } catch (e) {
      console.warn("[news] load sources failed:", e);
    }
  }, []);

  const loadArticles = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "100" });
      if (tab.kind === "source") params.set("source", String(tab.id));
      if (tab.kind === "pinned") params.set("pinned_only", "1");
      const res = await fetch(`/api/news?${params.toString()}`);
      if (!res.ok) return;
      const d = (await res.json()) as { articles: Article[] };
      setArticles(d.articles ?? []);
    } catch (e) {
      console.warn("[news] load articles failed:", e);
    } finally {
      setLoading(false);
    }
  }, [tab]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    void loadSources();
  }, [open, loadSources]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    void loadArticles();
  }, [open, loadArticles]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const togglePin = async (article: Article) => {
    try {
      const next = !article.pinned;
      const res = await fetch(`/api/news/${article.id}/pin`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned: next }),
      });
      if (!res.ok) return;
      setArticles((prev) =>
        prev.map((a) => (a.id === article.id ? { ...a, pinned: next } : a))
      );
    } catch (e) {
      console.warn("[news] toggle pin failed:", e);
    }
  };

  const { mounted, closing } = useModalTransition(open);
  if (!mounted) return null;

  return (
    <div
      className={`news-modal-backdrop ${closing ? "modal-closing" : ""}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className={`news-modal ${closing ? "modal-closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="news-modal-title">
        <button
          type="button"
          className="news-modal-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <header className="news-modal-header">
          <h2 id="news-modal-title">ニュース</h2>
        </header>

        <nav className="news-tabs">
          <button
            type="button"
            className={`news-tab ${tab.kind === "all" ? "active" : ""}`}
            onClick={() => setTab({ kind: "all" })}
          >
            すべて
          </button>
          <button
            type="button"
            className={`news-tab ${tab.kind === "pinned" ? "active" : ""}`}
            onClick={() => setTab({ kind: "pinned" })}
          >
            ★ 保存済み
          </button>
          {sources.filter((s) => s.enabled).map((s) => (
            <button
              key={s.id}
              type="button"
              className={`news-tab ${tab.kind === "source" && tab.id === s.id ? "active" : ""}`}
              onClick={() => setTab({ kind: "source", id: s.id })}
            >
              {s.name}
            </button>
          ))}
        </nav>

        <div className="news-body">
          {loading ? (
            <div className="news-loading">読み込み中…</div>
          ) : articles.length === 0 ? (
            <div className="news-empty">
              {tab.kind === "pinned"
                ? "保存したニュースはまだありません。記事の ★ ボタンで保存できます。"
                : "ニュースがまだありません。1 時間毎に自動取得されます。"}
            </div>
          ) : (
            <ul className="news-list">
              {articles.map((a) => (
                <li key={a.id} className={`news-item ${a.pinned ? "pinned" : ""}`}>
                  <button
                    type="button"
                    className={`news-pin ${a.pinned ? "pinned" : ""}`}
                    onClick={() => void togglePin(a)}
                    aria-label={a.pinned ? "保存解除" : "保存"}
                    title={a.pinned ? "保存解除" : "保存 (3 日後の自動削除から除外)"}
                  >
                    {a.pinned ? "★" : "☆"}
                  </button>
                  <div className="news-meta">
                    <span className="news-source">{a.source_name}</span>
                    <time className="news-time">{fmtTime(a.published_at)}</time>
                  </div>
                  {a.link ? (
                    <a
                      href={a.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="news-title"
                    >
                      {a.title}
                    </a>
                  ) : (
                    <span className="news-title">{a.title}</span>
                  )}
                  {a.summary && <p className="news-summary">{a.summary}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

