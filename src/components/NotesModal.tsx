"use client";

/**
 * ノート空間 Modal (docs/yui-notes.md §7)。
 *  - 左ペイン: 検索 (debounce サーバ検索) + source フィルタ + 「+新規」 + 一覧 (無限スクロール)
 *  - 右ペイン: 選択ノートの markdown ビューア / インライン編集、または新規作成フォーム
 *  - markdown は react-markdown + remark-gfm で描画 (= raw HTML 無効 = XSS 安全、§10)
 *  - browse モード (検索語なし) は offset 無限スクロール、search モードは候補上限 50 (deep paging なし)
 */
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useModalTransition } from "@/lib/useModalTransition";
import ProjectChipsEditor from "./ProjectChipsEditor";

type Props = {
  open: boolean;
  onClose: () => void;
  /** ReportPanel クリックで開いた時に右ペインへ表示するノート id。null なら通常オープン。 */
  focusNoteId?: number | null;
  /** focusNoteId を消費した (= select を発火した) ことを親に通知し、null に戻させる。 */
  onFocusConsumed?: () => void;
};

type NoteItem = {
  id: number;
  title: string;
  preview: string;
  source: string;
  pinned: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
};
type NoteDetail = NoteItem & { bodyMd: string };

type QueryResp =
  | { mode: "browse"; total: number; hasMore: boolean; notes: NoteItem[] }
  | { mode: "search"; total: number; searchTruncated: boolean; notes: NoteItem[] };

const PAGE = 100;
const SOURCE_LABEL: Record<string, string> = {
  human: "メモ",
  doc_agent: "ドキュメント",
  deep_research: "リサーチ",
  mcp: "MCP",
  tool_report: "レポート",
  project_note: "プロジェクト",
};
// "" (= すべて) + 全 source (SOURCE_LABEL 由来。source が増えても自動追従)
const SOURCE_FILTERS: string[] = ["", ...Object.keys(SOURCE_LABEL)];

function fmtDate(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export default function NotesModal({ open, onClose, focusNoteId, onFocusConsumed }: Props) {
  const { mounted, closing } = useModalTransition(open);

  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [source, setSource] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const [items, setItems] = useState<NoteItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [mode, setMode] = useState<"browse" | "search">("browse");

  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<NoteDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editBody, setEditBody] = useState("");
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState("");
  const [newBody, setNewBody] = useState("");
  const [busy, setBusy] = useState(false);

  const sentinelRef = useRef<HTMLLIElement | null>(null);
  const listRef = useRef<HTMLUListElement | null>(null);
  const fetchSeqRef = useRef(0); // fetchFirst の競合ガード (= 古い結果で上書きしない)
  const selectSeqRef = useRef(0); // select の競合ガード
  const loadingMoreRef = useRef(false); // loadMore の同期二重発火ガード
  // フォーカス select 時、遅延 debounce が「着地予定値」で reset を撃つのを 1 回だけ無効化する token。
  // 値特定 (debouncedQ === token) で skip するので、source 変更や追加入力の正当な reset は飲み込まない。
  const focusSkipTokenRef = useRef<string | null>(null);

  // 検索 debounce
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);

  // Escape: 編集/作成中ならまずそれをキャンセル、なければモーダルを閉じる
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (editing) setEditing(false);
      else if (creating) setCreating(false);
      else onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, editing, creating]);

  const buildUrl = useCallback(
    (offset: number) =>
      `/api/notes?limit=${PAGE}&offset=${offset}` +
      (debouncedQ ? `&q=${encodeURIComponent(debouncedQ)}` : "") +
      (source ? `&source=${source}` : "") +
      (showArchived ? "&archived=1" : ""),
    [debouncedQ, source, showArchived]
  );

  const fetchFirst = useCallback(async () => {
    if (!open) return;
    const seq = ++fetchSeqRef.current;
    setLoading(true);
    try {
      const res = await fetch(buildUrl(0));
      if (seq !== fetchSeqRef.current) return; // 古いリクエスト = 破棄
      if (!res.ok) return;
      const data = (await res.json()) as QueryResp;
      if (seq !== fetchSeqRef.current) return;
      setItems(data.notes ?? []);
      setTotal(data.total ?? 0);
      setMode(data.mode);
      setHasMore(data.mode === "browse" ? data.hasMore : false);
    } catch (e) {
      console.warn("[notes] fetch failed:", e);
    } finally {
      if (seq === fetchSeqRef.current) setLoading(false);
    }
  }, [open, buildUrl]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- search/open fetch
    void fetchFirst();
  }, [fetchFirst]);

  // 検索語 / source フィルタが変わったら右ペインの選択を解除 (= 一覧に無いノートを出し続けない)。
  // reset を debouncedQ 用 / source 用に分離し、フォーカス token skip は debouncedQ 側だけに適用する
  // (= source 変更を誤って飲み込まない。設計 docs/yui-notes.md §6.3.1)。
  /* eslint-disable react-hooks/set-state-in-effect -- フィルタ変更時の意図的なリセット */
  useEffect(() => {
    // 検索語 reset。フォーカス時に立てた「遅延 debounce 着地予定値」と一致した 1 回だけ skip する。
    const skip = focusSkipTokenRef.current;
    focusSkipTokenRef.current = null; // token は次の 1 回で使い切る
    if (skip !== null && debouncedQ === skip) return; // 遅延 debounce 着地による spurious reset のみ skip
    // 実際にクリアする時は in-flight の select() も失効させる (= 後から resolve して右ペインを
    // 復活させる競合を防ぐ)。skip 経路では bump しない (= 保持したい focus select を捨てないため)。
    selectSeqRef.current++;
    setSelectedId(null);
    setDetail(null);
    setEditing(false);
    setCreating(false);
  }, [debouncedQ]);

  useEffect(() => {
    // source reset。常にクリア (= ユーザー起因のフィルタ変更なので skip しない)。古い token は捨てる。
    focusSkipTokenRef.current = null;
    selectSeqRef.current++; // in-flight の select() を失効
    setSelectedId(null);
    setDetail(null);
    setEditing(false);
    setCreating(false);
  }, [source]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const loadMore = useCallback(async () => {
    // 同期 ref ガードで観測の二重発火を防ぐ。loading 中 (初回 fetch) も走らせない。
    if (loadingMoreRef.current || loading || !hasMore || mode !== "browse") return;
    // 現在のクエリの seq を捕捉。検索語/source が変わると fetchFirst が seq を進めるので、
    // 追加取得の途中でフィルタが変わった場合は結果を破棄する (= 別条件のノートを混ぜない)。
    const seq = fetchSeqRef.current;
    loadingMoreRef.current = true;
    setLoadingMore(true);
    try {
      const res = await fetch(buildUrl(items.length));
      if (seq !== fetchSeqRef.current) return; // フィルタが変わった = 破棄
      if (!res.ok) return;
      const data = (await res.json()) as QueryResp;
      if (seq !== fetchSeqRef.current) return;
      // 関数型更新で最新の prev に append (= offset closure ずれを回避)
      setItems((prev) => [...prev, ...(data.notes ?? [])]);
      setHasMore(data.mode === "browse" ? data.hasMore : false);
    } catch (e) {
      console.warn("[notes] loadMore failed:", e);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
    }
  }, [loading, hasMore, mode, buildUrl, items.length]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    // root を内側スクロール領域 (.notes-list) にする (= viewport 基準だと常時可視で連続ロード)
    const obs = new IntersectionObserver(
      (ents) => {
        if (ents[0]?.isIntersecting) void loadMore();
      },
      { root: listRef.current, rootMargin: "200px" }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadMore, hasMore]);

  const select = useCallback(async (id: number) => {
    const seq = ++selectSeqRef.current;
    setCreating(false);
    setEditing(false);
    setSelectedId(id);
    setDetail(null);
    try {
      const res = await fetch(`/api/notes/${id}`);
      if (seq !== selectSeqRef.current) return; // 別ノートを選び直した = 破棄
      if (!res.ok) return;
      const data = (await res.json()) as { note: NoteDetail };
      if (seq !== selectSeqRef.current) return;
      setDetail(data.note);
    } catch (e) {
      console.warn("[notes] detail failed:", e);
    }
  }, []);

  // ReportPanel のタイトルタブから開かれた時 (focusNoteId 指定)、該当ノートを右ペインに表示する。
  // select は /api/notes/{id} を直接引くので一覧 load 状態に依存しない。消費後は親に通知して null へ戻す。
  /* eslint-disable react-hooks/set-state-in-effect -- prop (focusNoteId) 起因の意図的な select 同期 */
  useEffect(() => {
    if (!open || focusNoteId == null) return;
    // pending debounce がある時だけ「着地予定値」を token に記録 (= 遅延 debounce の spurious reset を 1 回無効化)。
    const trimmed = q.trim();
    if (trimmed !== debouncedQ) focusSkipTokenRef.current = trimmed;
    void select(focusNoteId);
    onFocusConsumed?.();
  }, [open, focusNoteId, q, debouncedQ, select, onFocusConsumed]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const startCreate = () => {
    setCreating(true);
    setEditing(false);
    setSelectedId(null);
    setDetail(null);
    setNewTitle("");
    setNewBody("");
  };

  const submitCreate = async () => {
    const body = newBody.trim();
    if (!body || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/notes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() || undefined, body_md: body }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { note: NoteDetail };
      setCreating(false);
      await fetchFirst();
      await select(data.note.id);
    } catch (e) {
      console.warn("[notes] create failed:", e);
    } finally {
      setBusy(false);
    }
  };

  const startEdit = () => {
    if (!detail) return;
    setEditTitle(detail.title);
    setEditBody(detail.bodyMd);
    setEditing(true);
  };

  const submitEdit = async () => {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/notes/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: editTitle.trim(), body_md: editBody }),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { note: NoteDetail };
      setDetail(data.note);
      setEditing(false);
      setItems((prev) => prev.map((n) => (n.id === data.note.id ? { ...n, ...data.note } : n)));
    } catch (e) {
      console.warn("[notes] edit failed:", e);
    } finally {
      setBusy(false);
    }
  };

  const patchFlag = async (patch: { pinned?: boolean; archived?: boolean }) => {
    if (!detail || busy) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/notes/${detail.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!res.ok) return;
      const data = (await res.json()) as { note: NoteDetail };
      // archive した時は既定一覧から消えるので右ペインも閉じる。それ以外は detail 更新。
      if (patch.archived === true) {
        setSelectedId(null);
        setDetail(null);
        setEditing(false);
      } else {
        setDetail(data.note);
      }
      // pinned は並びが変わる / archived は消えるので一覧再取得
      await fetchFirst();
    } catch (e) {
      console.warn("[notes] flag patch failed:", e);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!detail || busy) return;
    if (!window.confirm(`「${detail.title}」を削除しますか？ (元に戻せません)`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/notes/${detail.id}`, { method: "DELETE" });
      if (!res.ok) return;
      setItems((prev) => prev.filter((n) => n.id !== detail.id));
      setSelectedId(null);
      setDetail(null);
    } catch (e) {
      console.warn("[notes] delete failed:", e);
    } finally {
      setBusy(false);
    }
  };

  if (!mounted) return null;

  return (
    <div
      className={`notes-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`notes-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="notes-modal-title"
      >
        <button type="button" className="notes-modal-close" onClick={onClose} aria-label="閉じる">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <header className="notes-modal-header">
          <h1 id="notes-modal-title">ノート</h1>
        </header>

        <div className="notes-modal-body">
          {/* 左ペイン */}
          <div className="notes-list-pane">
            <div className="notes-toolbar">
              <input
                type="text"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="検索 (本文 / タイトル)"
                className="notes-search"
              />
              <button type="button" className="todo-add-btn" onClick={startCreate}>
                ＋ 新規
              </button>
            </div>
            <div className="notes-source-filters">
              {SOURCE_FILTERS.map((s) => (
                <button
                  key={s || "all"}
                  type="button"
                  className={`notes-source-chip ${source === s ? "on" : ""}`}
                  aria-pressed={source === s}
                  onClick={() => setSource(s)}
                >
                  {s ? (SOURCE_LABEL[s] ?? s) : "すべて"}
                </button>
              ))}
              <button
                type="button"
                className={`notes-source-chip notes-archive-chip ${showArchived ? "on" : ""}`}
                aria-pressed={showArchived}
                onClick={() => setShowArchived((v) => !v)}
                title="アーカイブを含めて表示"
              >
                アーカイブ
              </button>
            </div>
            <div className="notes-count">
              {mode === "search" ? `「${debouncedQ}」 ` : "全 "}
              {total.toLocaleString()} 件
              {mode === "search" && total > items.length ? " (上位 50)" : ""}
            </div>

            {loading && items.length === 0 && <div className="settings-placeholder">読み込み中…</div>}
            {!loading && items.length === 0 && (
              <div className="settings-placeholder">
                {debouncedQ ? "該当するノートがありません" : "まだノートがありません"}
              </div>
            )}

            <ul className="notes-list" ref={listRef}>
              {items.map((n) => (
                <li key={n.id}>
                  <button
                    type="button"
                    className={`notes-list-item ${selectedId === n.id ? "selected" : ""} ${n.archived ? "archived" : ""}`}
                    aria-current={selectedId === n.id}
                    onClick={() => void select(n.id)}
                  >
                    <div className="notes-list-item-head">
                      {n.pinned && <span className="notes-pin-dot" title="ピン留め" />}
                      <span className="notes-list-title">{n.title || "無題"}</span>
                      {n.archived && <span className="notes-archived-tag">済</span>}
                      <span className={`notes-source-badge notes-source-${n.source}`}>
                        {SOURCE_LABEL[n.source] ?? n.source}
                      </span>
                    </div>
                    <div className="notes-list-preview">{n.preview}</div>
                    <div className="notes-list-date">{fmtDate(n.updatedAt)}</div>
                  </button>
                </li>
              ))}
              {hasMore && <li ref={sentinelRef} className="notes-sentinel" aria-hidden />}
            </ul>
            {loadingMore && <div className="settings-placeholder">読み込み中…</div>}
          </div>

          {/* 右ペイン */}
          <div className="notes-detail-pane">
            {creating ? (
              <div className="notes-editor">
                <input
                  type="text"
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="タイトル (省略可)"
                  className="notes-edit-title"
                />
                <textarea
                  value={newBody}
                  onChange={(e) => setNewBody(e.target.value)}
                  placeholder="markdown で本文を書く…"
                  className="notes-edit-body"
                  autoFocus
                />
                <div className="notes-editor-actions">
                  <button type="button" className="confirm-cancel-btn" onClick={() => setCreating(false)}>
                    キャンセル
                  </button>
                  <button
                    type="button"
                    className="todo-add-btn"
                    onClick={() => void submitCreate()}
                    disabled={!newBody.trim() || busy}
                  >
                    保存
                  </button>
                </div>
              </div>
            ) : detail ? (
              editing ? (
                <div className="notes-editor">
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="タイトル"
                    className="notes-edit-title"
                  />
                  <textarea
                    value={editBody}
                    onChange={(e) => setEditBody(e.target.value)}
                    className="notes-edit-body"
                  />
                  <div className="notes-editor-actions">
                    <button type="button" className="confirm-cancel-btn" onClick={() => setEditing(false)}>
                      キャンセル
                    </button>
                    <button
                      type="button"
                      className="todo-add-btn"
                      onClick={() => void submitEdit()}
                      disabled={busy}
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <div className="notes-viewer">
                  <div className="notes-viewer-head">
                    <h2>{detail.title || "無題"}</h2>
                    <div className="notes-viewer-actions">
                      <button
                        type="button"
                        className={`notes-icon-btn ${detail.pinned ? "on" : ""}`}
                        onClick={() => void patchFlag({ pinned: !detail.pinned })}
                        title={detail.pinned ? "ピン留め解除" : "ピン留め"}
                        aria-label={detail.pinned ? "ピン留め解除" : "ピン留め"}
                        aria-pressed={detail.pinned}
                        disabled={busy}
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill={detail.pinned ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M12 17v5" />
                          <path d="M9 10.8V4h6v6.8a2 2 0 0 0 .6 1.4l1.4 1.4a1 1 0 0 1 .3.7v.7H6.7v-.7a1 1 0 0 1 .3-.7l1.4-1.4A2 2 0 0 0 9 10.8Z" />
                        </svg>
                      </button>
                      <button type="button" className="todo-cancel-btn" onClick={startEdit} disabled={busy}>
                        編集
                      </button>
                      <button
                        type="button"
                        className="notes-icon-btn"
                        onClick={() => void patchFlag({ archived: !detail.archived })}
                        title={detail.archived ? "アーカイブ解除" : "アーカイブ"}
                        aria-label={detail.archived ? "アーカイブ解除" : "アーカイブ"}
                        disabled={busy}
                      >
                        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <rect width="20" height="5" x="2" y="3" rx="1" />
                          <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
                          <path d="M10 12h4" />
                        </svg>
                      </button>
                      <button type="button" className="dictionary-delete-btn" onClick={() => void remove()} disabled={busy} aria-label="削除">
                        ×
                      </button>
                    </div>
                  </div>
                  <div className="notes-viewer-meta">
                    <span className={`notes-source-badge notes-source-${detail.source}`}>
                      {SOURCE_LABEL[detail.source] ?? detail.source}
                    </span>
                    <span>{fmtDate(detail.updatedAt)}</span>
                  </div>
                  {/* プロジェクト紐付け (= 既存 project_links M:N、artifactType="memo")。保存済 note のみ */}
                  <div className="notes-viewer-projects">
                    <ProjectChipsEditor
                      artifactType="memo"
                      artifactId={String(detail.id)}
                      label="プロジェクト"
                    />
                  </div>
                  <div className="notes-markdown">
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{detail.bodyMd}</ReactMarkdown>
                  </div>
                </div>
              )
            ) : (
              <div className="settings-placeholder notes-empty">
                {selectedId ? "読み込み中…" : "ノートを選択するか、＋新規で作成"}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
