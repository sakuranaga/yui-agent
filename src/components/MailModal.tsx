"use client";

/**
 * メール統合モーダル (2 ペイン)。
 *
 * - 左: メール一覧 (score 順 or 受信時刻順、閾値以下は折りたたみ)
 *   各行に「アカウントバッジ」表示で複数アカウント識別。右クリックメニューあり。
 * - 右: 選択中メールの本文 (HTML は iframe sandbox で隔離 render)
 *
 * 設計: docs/mail-system.md §6
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import DOMPurify from "isomorphic-dompurify";
import { useModalTransition } from "@/lib/useModalTransition";
import MailComposeModal, { type ComposeMode } from "./MailComposeModal";
import ProjectChipsEditor from "./ProjectChipsEditor";
import ArtifactLinksPanel from "./ArtifactLinksPanel";
import MailTrainingModal from "./MailTrainingModal";

type Account = {
  id: number;
  email: string;
  displayName: string | null;
  enabled: boolean;
  isPrimary: boolean;
};

type ListItem = {
  id: number;
  accountEmail: string;
  threadId: string;
  gmailMessageId: string;
  fromName: string | null;
  fromEmail: string;
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  labels: string[];
  score: number | null;
  scoreReason: string | null;
  bucket: "important" | "needed" | "unneeded" | null;
  bucketConfidence: number | null;
  bucketReason: string | null;
  read: boolean;
  starred: boolean;
  archived: boolean;
  trashed: boolean;
  hasBody: boolean;
};

type View = "inbox" | "sent" | "archive" | "trash" | "starred";
type Counts = Record<View, number>;

type Detail = {
  id: number;
  gmailMessageId: string;
  threadId: string;
  accountEmail: string;
  from: { address: string; name: string | null; email: string };
  to: string[];
  subject: string | null;
  snippet: string | null;
  receivedAt: string;
  labels: string[];
  score: number | null;
  scoreReason: string | null;
  bucket: "important" | "needed" | "unneeded" | null;
  bucketConfidence: number | null;
  bucketReason: string | null;
  classifiedAt: string | null;
  bodyText: string | null;
  bodyHtml: string | null;
  bodyFetchedAt: string | null;
  read: boolean;
  starred: boolean;
  archived: boolean;
  trashed: boolean;
  thread: Array<{
    id: number;
    fromName: string | null;
    fromEmail: string;
    subject: string | null;
    receivedAt: string;
  }>;
  latestTraining: {
    bucket: "important" | "needed" | "unneeded";
    hintText: string;
    autoTodo: boolean;
    autoEvent: boolean;
  } | null;
  attachments: Array<{
    id: number;
    filename: string;
    mimeType: string | null;
    sizeBytes: number | null;
    gmailPartId: string | null;
  }>;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

type SortMode = "score" | "date";

export default function MailModal({ open, onClose }: Props) {
  const transition = useModalTransition(open);
  const [items, setItems] = useState<ListItem[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [threshold, setThreshold] = useState(0.5);
  const [sort, setSort] = useState<SortMode>("score");
  const [view, setView] = useState<View>("inbox");
  const [counts, setCounts] = useState<Counts>({ inbox: 0, sent: 0, archive: 0, trash: 0, starred: 0 });
  const [showBelow, setShowBelow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [polling, setPolling] = useState(false);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailReloadKey, setDetailReloadKey] = useState(0);
  // 学習モーダル: 対象 mail id を持つ間だけ open。badge / kebab どちらからでも起動可。
  // detail.id がこの値と一致した時点で初めて open する (badge を別行で押した時の race 対策)。
  const [trainingForId, setTrainingForId] = useState<number | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; item: ListItem } | null>(null);
  const [search, setSearch] = useState("");
  const [compose, setCompose] = useState<ComposeMode | null>(null);
  const [checked, setChecked] = useState<Set<number>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [viewPickerOpen, setViewPickerOpen] = useState(false);
  // Shift+クリックでの range select の起点 (最後にクリックした id)
  const [anchorId, setAnchorId] = useState<number | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/mail/list?view=${view}&sort=${sort}&limit=300&t=${Date.now()}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const data = (await res.json()) as {
        items: ListItem[];
        accounts: Account[];
        threshold: number;
        counts: Counts;
      };
      setItems(data.items);
      setAccounts(data.accounts);
      setThreshold(data.threshold);
      setCounts(data.counts);
    } catch (e) {
      console.warn("[mail] list failed:", e);
    } finally {
      setLoading(false);
    }
  }, [sort, view]);

  // open / view 切替時にチェック選択を reset + 一覧を再 fetch。
  // checked/selectMode は anti-pattern #3 (key prop) の対象だが、modal 再 mount で
  // フィルタ条件まで失うため自前 reset。reload は legitimate external sync。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setChecked(new Set()); // view 切替時に選択 reset
    setSelectMode(false);
    void reload();
  }, [open, reload]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // SSE: 自動 / 手動 mail-poll が新着を INSERT したら server が broadcast → window event
  // (ChatPanel が SSE → window dispatch している。MailModal は window だけ listen)
  useEffect(() => {
    if (!open) return;
    const handler = () => {
      void reload();
    };
    window.addEventListener("yui-mail-inserted", handler);
    return () => window.removeEventListener("yui-mail-inserted", handler);
  }, [open, reload]);

  // 詳細 fetch
  useEffect(() => {
    if (selectedId === null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- clear-on-deselect, no cascade
      setDetail(null);
      return;
    }
    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      try {
        const res = await fetch(`/api/mail/${selectedId}`, { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as Detail;
        if (cancelled) return;
        setDetail(data);
        // 既読化 (まだ未読なら)
        if (!data.read) {
          void fetch(`/api/mail/${selectedId}/state`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ read: true }),
          });
          setItems((cur) =>
            cur.map((x) => (x.id === selectedId ? { ...x, read: true } : x))
          );
        }
      } catch (e) {
        console.warn("[mail] detail failed:", e);
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, detailReloadKey]);

  // 学習モーダル保存後に detail を再取得 (bucket バッジ / kebab ラベル反映)
  useEffect(() => {
    const handler = (e: Event) => {
      const evt = e as CustomEvent<{ mailId: number }>;
      if (evt.detail?.mailId === selectedId) {
        setDetailReloadKey((k) => k + 1);
      }
    };
    window.addEventListener("mail-training-saved", handler as EventListener);
    return () => window.removeEventListener("mail-training-saved", handler as EventListener);
  }, [selectedId]);

  // 検索 + 閾値で分割
  // visibleIdsRef は range select 用に同期する。
  const { abovePassing, belowThreshold } = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = q
      ? items.filter((it) =>
          [it.subject, it.snippet, it.fromName, it.fromEmail]
            .map((s) => (s ?? "").toLowerCase())
            .some((s) => s.includes(q))
        )
      : items;
    const above: ListItem[] = [];
    const below: ListItem[] = [];
    for (const it of filtered) {
      if ((it.score ?? 0) >= threshold) above.push(it);
      else below.push(it);
    }
    return { abovePassing: above, belowThreshold: below };
  }, [items, threshold, search]);

  // 折りたたみ状態を含めた「実際に見えてる行の id 順」を ref で持つ。
  // showBelow / view が変わったら再計算。
  useEffect(() => {
    const visible: number[] = abovePassing.map((x) => x.id);
    if (showBelow || view === "trash") {
      for (const x of belowThreshold) visible.push(x.id);
    }
    visibleIdsRef.current = visible;
  }, [abovePassing, belowThreshold, showBelow, view]);

  type StatePatch = {
    read?: boolean;
    starred?: boolean;
    archived?: boolean;
    trashed?: boolean;
  };

  // 状態変更ヘルパー (単一)
  const patchState = useCallback(
    async (id: number, patch: StatePatch) => {
      // optimistic
      setItems((cur) =>
        cur.map((x) => {
          if (x.id !== id) return x;
          return {
            ...x,
            ...(patch.read !== undefined ? { read: patch.read } : {}),
            ...(patch.starred !== undefined ? { starred: patch.starred } : {}),
            ...(patch.archived !== undefined ? { archived: patch.archived } : {}),
            ...(patch.trashed !== undefined ? { trashed: patch.trashed } : {}),
          };
        })
      );
      // view から外れる操作は selection / list から消す
      const willLeaveView =
        (view === "inbox" && (patch.archived === true || patch.trashed === true)) ||
        (view === "archive" && (patch.trashed === true || patch.archived === false)) ||
        (view === "trash" && patch.trashed === false) ||
        (view === "starred" && patch.starred === false);
      if (willLeaveView && selectedId === id) setSelectedId(null);
      try {
        await fetch(`/api/mail/${id}/state`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (willLeaveView) {
          setItems((cur) => cur.filter((x) => x.id !== id));
        }
        // counts 再取得のため reload
        void reload();
      } catch (e) {
        console.warn("[mail] state patch failed:", e);
        await reload();
      }
    },
    [reload, selectedId, view]
  );

  // 一括 patch (multi-select 用)
  const batchPatch = useCallback(
    async (ids: number[], patch: StatePatch) => {
      if (ids.length === 0) return;
      try {
        await fetch(`/api/mail/batch`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ids, patch }),
        });
        setChecked(new Set());
        await reload();
      } catch (e) {
        console.warn("[mail] batch failed:", e);
        await reload();
      }
    },
    [reload]
  );

  /** Gmail から新着 fetch を即時実行。実行中は 2 秒ごとに list を再 fetch して
   *  DB に届いた分から動的にリストに流し込む。 */
  const pollNow = useCallback(async () => {
    setPolling(true);
    // poll 中は 2 秒毎に list refresh
    const ticker = setInterval(() => {
      void reload();
    }, 2000);
    try {
      const res = await fetch("/api/mail/poll", { method: "POST" });
      if (!res.ok) {
        console.warn("[mail] poll failed:", res.status);
      } else {
        const data = (await res.json()) as { inserted?: number };
        console.log(`[mail] poll inserted=${data.inserted ?? 0}`);
      }
    } catch (e) {
      console.warn("[mail] poll failed:", e);
    } finally {
      clearInterval(ticker);
      await reload(); // 最終確定
      setPolling(false);
    }
  }, [reload]);

  const emptyTrash = useCallback(async () => {
    if (!confirm("ゴミ箱を空にしますか? すべて物理削除されます (元に戻せません)。")) return;
    try {
      await fetch(`/api/mail/empty-trash`, { method: "POST" });
      setChecked(new Set());
      setSelectedId(null);
      await reload();
    } catch (e) {
      console.warn("[mail] empty trash failed:", e);
    }
  }, [reload]);

  const toggleCheck = useCallback((id: number) => {
    setChecked((cur) => {
      const next = new Set(cur);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // 表示中の id 順 (range select に使う)。閾値以下が折りたたみで非表示なら除外する。
  const visibleIdsRef = useRef<number[]>([]);

  /**
   * 行クリック共通ハンドラ。
   * - Shift+click → anchor から click 先まで範囲選択 + selectMode ON
   * - Ctrl/Meta+click → 個別 toggle + selectMode ON
   * - 通常クリック →
   *     selectMode 中なら toggle
   *     通常モードなら詳細表示 (setSelectedId)
   */
  const handleRowClick = useCallback(
    (id: number, e: React.MouseEvent) => {
      if (e.shiftKey && anchorId !== null) {
        const ids = visibleIdsRef.current;
        const i1 = ids.indexOf(anchorId);
        const i2 = ids.indexOf(id);
        if (i1 >= 0 && i2 >= 0) {
          const [lo, hi] = i1 < i2 ? [i1, i2] : [i2, i1];
          const range = ids.slice(lo, hi + 1);
          setSelectMode(true);
          setChecked((cur) => {
            const next = new Set(cur);
            for (const x of range) next.add(x);
            return next;
          });
          setAnchorId(id);
          return;
        }
      }
      if (e.ctrlKey || e.metaKey) {
        setSelectMode(true);
        toggleCheck(id);
        setAnchorId(id);
        return;
      }
      // 通常クリック
      //   selectMode 中: チェック切替 + 詳細表示も同時に (内容確認しながら選択できるように)
      //   通常モード: 詳細表示のみ
      if (selectMode) toggleCheck(id);
      setSelectedId(id);
      setAnchorId(id);
    },
    [anchorId, selectMode, toggleCheck]
  );

  const addVipOrBlock = useCallback(async (email: string, kind: "vip" | "block") => {
    try {
      const cur = await fetch("/api/mail/curation-settings", { cache: "no-store" }).then((r) => r.json());
      const key = kind === "vip" ? "vipAddresses" : "blockedAddresses";
      const list: string[] = cur[key] ?? [];
      const lower = email.toLowerCase();
      if (list.includes(lower)) return;
      await fetch("/api/mail/curation-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: [...list, lower] }),
      });
    } catch (e) {
      console.warn("[mail] vip/block update failed:", e);
    }
  }, []);

  // メニューを閉じる
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    return () => {
      document.removeEventListener("click", close);
    };
  }, [menu]);

  // Esc で modal close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !menu) onClose();
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, menu]);

  if (!transition.mounted) return null;
  const closing = transition.closing;

  return (
    <div
      className={`mail-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`mail-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="mail-modal-title"
      >
        <button
          type="button"
          className="todo-modal-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <header className="mail-modal-header">
          <h1 id="mail-modal-title">メール</h1>
          <div className="todo-search-wrapper">
            <svg
              className="todo-search-icon"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="16.5" y1="16.5" x2="21" y2="21" />
            </svg>
            <input
              type="text"
              name="mail-search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="todo-filter-input todo-filter-input-header"
              aria-label="検索"
              placeholder=""
            />
          </div>
          <div className="mail-modal-header-tools">
            <button
              type="button"
              className={`mail-sort-btn ${sort === "score" ? "active" : ""}`}
              onClick={() => setSort("score")}
            >
              重要度順
            </button>
            <button
              type="button"
              className={`mail-sort-btn ${sort === "date" ? "active" : ""}`}
              onClick={() => setSort("date")}
            >
              新着順
            </button>
            <button
              type="button"
              className={`mail-sort-btn mail-sort-btn-icon ${polling ? "polling" : ""}`}
              onClick={() => void pollNow()}
              title="Gmail から新着を取得"
              aria-label="新着取得"
              disabled={polling}
            >
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="23 4 23 10 17 10" />
                <polyline points="1 20 1 14 7 14" />
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15" />
              </svg>
              {polling && <span>取得中…</span>}
            </button>
            <span className="mail-modal-divider">|</span>
            <button
              type="button"
              className={`mail-sort-btn ${selectMode ? "active" : ""}`}
              onClick={() => {
                setSelectMode((v) => !v);
                if (selectMode) setChecked(new Set());
              }}
              title="選択モード"
            >
              {selectMode ? "選択モード OFF" : "選択モード"}
            </button>
            {selectMode && checked.size > 0 && (
              <>
                <span className="mail-checked-info">{checked.size} 件選択</span>
                <button
                  type="button"
                  className="mail-sort-btn mail-sort-btn-icon"
                  onClick={() => void batchPatch(Array.from(checked), { trashed: true })}
                  title="一括ゴミ箱"
                >
                  <TrashIcon /> ゴミ箱へ
                </button>
              </>
            )}
          </div>
          <div className="todo-modal-actions">
            <button
              type="button"
              className="todo-add-btn"
              onClick={() => setCompose({ kind: "new" })}
            >
              ＋ 新規
            </button>
          </div>
        </header>

        {/* body: 2 ペイン */}
        <div className="mail-modal-body">
          {/* left: list pane (TODO 流儀: 大きい view selector + dropdown + 件数) */}
          <aside className="mail-list-pane">
            <div className="todo-filter">
              <div className="todo-project-header">
                <button
                  type="button"
                  className="todo-project-display"
                  onClick={() => setViewPickerOpen((v) => !v)}
                  title="ビュー切替"
                >
                  {VIEW_LABEL[view]}
                  <svg
                    className="todo-project-chevron"
                    viewBox="0 0 12 8"
                    width="14"
                    height="10"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="2 2 6 6 10 2" />
                  </svg>
                </button>
                {viewPickerOpen && (
                  <ViewPickerPopup
                    counts={counts}
                    current={view}
                    onPick={(v) => {
                      setView(v);
                      setViewPickerOpen(false);
                    }}
                    onClose={() => setViewPickerOpen(false)}
                  />
                )}
                <div className="mail-list-headstats">
                  <span className="mail-list-stat">
                    {VIEW_LABEL[view]} <strong>{counts[view]}</strong>
                  </span>
                  {view === "trash" && counts.trash > 0 && (
                    <button
                      type="button"
                      className="mail-empty-trash-btn"
                      onClick={() => void emptyTrash()}
                      title="ゴミ箱を空にする (物理削除)"
                    >
                      空にする
                    </button>
                  )}
                </div>
              </div>
            </div>
            <div className="mail-list">
            {loading && items.length === 0 ? (
              <div className="mail-empty">読み込み中…</div>
            ) : abovePassing.length === 0 && belowThreshold.length === 0 ? (
              <div className="mail-empty">メールがありません</div>
            ) : (
              <>
                {abovePassing.map((it) => (
                  <MailRow
                    key={it.id}
                    item={it}
                    accountCount={accounts.length}
                    selected={selectedId === it.id}
                    checked={checked.has(it.id)}
                    selectMode={selectMode}
                    onRowClick={(e) => handleRowClick(it.id, e)}
                    onCheck={() => toggleCheck(it.id)}
                    onTrash={() => void patchState(it.id, { trashed: true })}
                    onArchive={() => void patchState(it.id, { archived: !it.archived })}
                    onStar={() => void patchState(it.id, { starred: !it.starred })}
                    onContextMenu={(x, y) => setMenu({ x, y, item: it })}
                    onBadgeClick={() => { setSelectedId(it.id); setTrainingForId(it.id); }}
                  />
                ))}
                {belowThreshold.length > 0 && view !== "trash" && (
                  <button
                    type="button"
                    className="mail-below-toggle"
                    onClick={() => setShowBelow((v) => !v)}
                  >
                    {showBelow ? "▲ 折りたたむ" : `▼ 興味なさそうな話題 ${belowThreshold.length} 件`}
                  </button>
                )}
                {(showBelow || view === "trash") &&
                  belowThreshold.map((it) => (
                    <MailRow
                      key={it.id}
                      item={it}
                      accountCount={accounts.length}
                      selected={selectedId === it.id}
                      checked={checked.has(it.id)}
                      selectMode={selectMode}
                      dimmed
                      onRowClick={(e) => handleRowClick(it.id, e)}
                      onCheck={() => toggleCheck(it.id)}
                      onTrash={() => void patchState(it.id, { trashed: true })}
                      onArchive={() => void patchState(it.id, { archived: !it.archived })}
                      onStar={() => void patchState(it.id, { starred: !it.starred })}
                      onContextMenu={(x, y) => setMenu({ x, y, item: it })}
                      onBadgeClick={() => { setSelectedId(it.id); setTrainingForId(it.id); }}
                    />
                  ))}
              </>
            )}
            </div>
          </aside>

          {/* right: detail */}
          <section className="mail-detail">
            {selectedId === null ? (
              <div className="mail-empty">左からメールを選んでください</div>
            ) : detailLoading && !detail ? (
              <div className="mail-empty">読み込み中…</div>
            ) : detail ? (
              <MailDetail
                detail={detail}
                onStar={() => void patchState(detail.id, { starred: !detail.starred })}
                onArchive={() => void patchState(detail.id, { archived: !detail.archived })}
                onTrash={() => void patchState(detail.id, { trashed: !detail.trashed })}
                onPickThread={(id) => setSelectedId(id)}
                onOpenTraining={() => setTrainingForId(detail.id)}
                onReply={() =>
                  setCompose({
                    kind: "reply",
                    inReplyToDbId: detail.id,
                    to: [detail.from.email],
                    subject: detail.subject ?? "",
                    quotedBody: buildQuotedBody(detail),
                    fromAccountEmail: detail.accountEmail,
                  })
                }
                onForward={() =>
                  setCompose({
                    kind: "forward",
                    inReplyToDbId: detail.id,
                    subject: detail.subject ?? "",
                    quotedBody: buildForwardBody(detail),
                    fromAccountEmail: detail.accountEmail,
                  })
                }
              />
            ) : (
              <div className="mail-empty">取得失敗</div>
            )}
          </section>
        </div>

        {/* Compose Modal (新規 / 返信 / 転送) */}
        <MailComposeModal
          open={compose !== null}
          mode={compose}
          onClose={() => {
            setCompose(null);
            void reload();
          }}
        />

        {/* 学習モーダル: detail がトレーニング対象の mail に追いついた時のみ open */}
        <MailTrainingModal
          open={trainingForId !== null && detail !== null && detail.id === trainingForId}
          onClose={() => setTrainingForId(null)}
          onSaved={() => {
            window.dispatchEvent(
              new CustomEvent("mail-training-saved", {
                detail: { mailId: trainingForId },
              })
            );
            // 受信箱リストも更新 (bucket / 並び順反映)
            void reload();
          }}
          mailId={detail?.id ?? 0}
          mailSubject={detail?.subject ?? null}
          mailFromLabel={
            detail
              ? detail.from.name
                ? `${detail.from.name} <${detail.from.email}>`
                : detail.from.email
              : ""
          }
          currentBucket={detail?.latestTraining?.bucket ?? detail?.bucket ?? null}
          currentHint={detail?.latestTraining?.hintText ?? detail?.bucketReason ?? null}
          currentAutoTodo={detail?.latestTraining?.autoTodo ?? false}
          currentAutoEvent={detail?.latestTraining?.autoEvent ?? false}
        />

        {/* 右クリックメニュー */}
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            item={menu.item}
            hasMultiSelected={checked.size > 0 && checked.has(menu.item.id)}
            checkedCount={checked.size}
            onClose={() => setMenu(null)}
            onToggleRead={() => void patchState(menu.item.id, { read: !menu.item.read })}
            onToggleStar={() => void patchState(menu.item.id, { starred: !menu.item.starred })}
            onArchive={() => void patchState(menu.item.id, { archived: !menu.item.archived })}
            onTrash={() => void patchState(menu.item.id, { trashed: !menu.item.trashed })}
            onBatchTrash={() => void batchPatch(Array.from(checked), { trashed: true })}
            onAddVip={() => void addVipOrBlock(menu.item.fromEmail, "vip")}
            onAddBlock={() => void addVipOrBlock(menu.item.fromEmail, "block")}
            onOpenGmail={() => {
              const url = `https://mail.google.com/mail/u/0/#all/${menu.item.gmailMessageId}`;
              window.open(url, "_blank", "noopener,noreferrer");
            }}
          />
        )}
      </div>
    </div>
  );
}

const VIEW_LABEL: Record<View, string> = {
  inbox: "受信箱",
  sent: "送信済",
  starred: "スター",
  archive: "アーカイブ",
  trash: "ゴミ箱",
};
const VIEW_ORDER: View[] = ["inbox", "sent", "starred", "archive", "trash"];

function ViewPickerPopup(props: {
  counts: Counts;
  current: View;
  onPick: (v: View) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [props]);
  return (
    <div ref={ref} className="todo-project-popup mail-view-popup">
      {VIEW_ORDER.map((v) => (
        <button
          key={v}
          type="button"
          className={`todo-project-popup-item ${v === props.current ? "active" : ""}`}
          onClick={() => props.onPick(v)}
        >
          <span>{VIEW_LABEL[v]}</span>
          {v !== "sent" && (
            <span className="mail-view-popup-count">{props.counts[v]}</span>
          )}
        </button>
      ))}
    </div>
  );
}

function MailRow(props: {
  item: ListItem;
  accountCount: number;
  selected: boolean;
  checked: boolean;
  selectMode: boolean;
  dimmed?: boolean;
  onRowClick: (e: React.MouseEvent) => void;
  onCheck: () => void;
  onTrash: () => void;
  onArchive: () => void;
  onStar: () => void;
  onContextMenu: (x: number, y: number) => void;
  onBadgeClick: () => void;
}) {
  const { item, selected, checked, selectMode, dimmed, onRowClick, onCheck, onTrash, onArchive, onStar, onContextMenu, accountCount, onBadgeClick } = props;
  const time = new Date(item.receivedAt).toLocaleString("ja-JP", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  // クリックハンドラ: アクション icon のクリックは propagation を止めて行選択しない
  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.stopPropagation();
    fn();
  };
  return (
    <div
      className={`mail-row ${selected ? "selected" : ""} ${item.read ? "" : "unread"} ${dimmed ? "dimmed" : ""} ${checked ? "checked" : ""} ${selectMode ? "select-mode" : ""}`}
      onClick={onRowClick}
      onContextMenu={(e) => {
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
    >
      {selectMode && (
        <input
          type="checkbox"
          className="mail-row-check"
          checked={checked}
          onClick={(e) => e.stopPropagation()}
          onChange={onCheck}
          aria-label="選択"
        />
      )}
      <div className="mail-row-main">
        <div className="mail-row-top">
          <span className="mail-row-from" title={item.fromEmail}>
            {item.fromName ?? item.fromEmail}
          </span>
          {accountCount > 1 && (
            <span className="mail-row-account" title={item.accountEmail}>
              {item.accountEmail.split("@")[0]}
            </span>
          )}
          <span className="mail-row-time">{time}</span>
        </div>
        <div className="mail-row-subject">{item.subject ?? "(件名なし)"}</div>
        <div className="mail-row-snippet">{item.snippet ?? ""}</div>
        <div className="mail-row-foot">
          <BucketBadge
            bucket={item.bucket}
            confidence={item.bucketConfidence}
            reason={item.bucketReason}
            onClick={onBadgeClick}
          />
        </div>
      </div>
      <div className="mail-row-actions">
        <button
          type="button"
          className={`mail-row-iconbtn ${item.starred ? "on" : ""}`}
          title={item.starred ? "スター外す" : "スターを付ける"}
          onClick={stop(onStar)}
          aria-label={item.starred ? "スターを外す" : "スターを付ける"}
        >
          <StarIcon filled={item.starred} />
        </button>
        <button
          type="button"
          className={`mail-row-iconbtn ${item.archived ? "on" : ""}`}
          title={item.archived ? "受信箱に戻す" : "アーカイブ"}
          onClick={stop(onArchive)}
          aria-label={item.archived ? "受信箱に戻す" : "アーカイブ"}
        >
          <ArchiveIcon />
        </button>
        <button
          type="button"
          className="mail-row-iconbtn danger"
          title="ゴミ箱へ"
          onClick={stop(onTrash)}
          aria-label="ゴミ箱へ"
        >
          <TrashIcon />
        </button>
      </div>
    </div>
  );
}

function MailDetail(props: {
  detail: Detail;
  onStar: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onPickThread: (id: number) => void;
  onReply: () => void;
  onForward: () => void;
  onOpenTraining: () => void;
}) {
  const { detail, onStar, onArchive, onTrash, onPickThread, onReply, onForward, onOpenTraining } = props;
  const time = new Date(detail.receivedAt).toLocaleString("ja-JP");

  return (
    <div className="mail-detail-inner">
      <div className="mail-detail-header">
        <div className="mail-detail-title-row">
          <h3>{detail.subject ?? "(件名なし)"}</h3>
          <div className="mail-detail-actions">
            <button type="button" className="mail-act-btn" onClick={onReply}>
              返信
            </button>
            <button type="button" className="mail-act-btn" onClick={onForward}>
              転送
            </button>
            <button type="button" className="mail-act-btn mail-act-icon" onClick={onStar} title={detail.starred ? "スター外す" : "スターを付ける"} aria-label={detail.starred ? "スターを外す" : "スターを付ける"}>
              <StarIcon filled={detail.starred} />
            </button>
            <button type="button" className="mail-act-btn mail-act-icon" onClick={onArchive} title={detail.archived ? "受信箱に戻す" : "アーカイブ"} aria-label={detail.archived ? "受信箱に戻す" : "アーカイブ"}>
              <ArchiveIcon />
            </button>
            <button type="button" className="mail-act-btn mail-act-icon danger" onClick={onTrash} title={detail.trashed ? "ゴミ箱から戻す" : "ゴミ箱へ"} aria-label={detail.trashed ? "ゴミ箱から戻す" : "ゴミ箱へ"}>
              {detail.trashed ? <UndoIcon /> : <TrashIcon />}
            </button>
            <MailKebabMenu detail={detail} onOpenTraining={onOpenTraining} />
          </div>
        </div>
        <div className="mail-detail-meta">
          <span>
            <strong>{detail.from.name ?? detail.from.email}</strong>{" "}
            <span className="mail-detail-from-email">&lt;{detail.from.email}&gt;</span>
          </span>
          <span>→ {detail.to.join(", ") || "(自分)"}</span>
          <span>{time}</span>
          <span className="mail-detail-account">via {detail.accountEmail}</span>
          {detail.score !== null && (
            <span className="mail-detail-score">
              重要度: <strong className={`score-${scoreBucket(detail.score)}`}>{detail.score.toFixed(2)}</strong>
              {detail.scoreReason && <> — {detail.scoreReason}</>}
            </span>
          )}
        </div>
        <ProjectChipsEditor
          artifactType="mail"
          artifactId={String(detail.id)}
          artifactPayload={{
            type: "mail",
            data: {
              subject: detail.subject ?? "",
              from: { name: detail.from.name ?? undefined, address: detail.from.email },
              to: detail.to.map((address) => ({ address })),
              bodySnippet: (detail.bodyText ?? detail.snippet ?? "").slice(0, 600),
              receivedAt: detail.receivedAt,
            },
          }}
          label="プロジェクト"
        />
      </div>

      <MailBodyIframe key={detail.id} detail={detail} />
      {!detail.bodyHtml && !detail.bodyText && (
        <div className="mail-empty">本文未取得</div>
      )}

      {detail.attachments.length > 0 && (
        <div className="mail-detail-attachments">
          <strong>📎 添付</strong>
          {detail.attachments.map((a) => (
            <a
              key={a.id}
              href={`/api/mail/${detail.id}/attachment/${a.id}`}
              className="mail-attachment"
              download={a.filename}
            >
              {a.filename}
              {a.sizeBytes !== null && (
                <span className="mail-attachment-size"> ({formatBytes(a.sizeBytes)})</span>
              )}
            </a>
          ))}
        </div>
      )}

      {(() => {
        const others = detail.thread.filter((t) => t.id !== detail.id);
        if (others.length === 0) return null;
        return (
          <div className="mail-detail-thread">
            <strong>このスレッドの他のメール ({others.length})</strong>
            {others.map((t) => (
              <button
                key={t.id}
                type="button"
                className="mail-thread-item"
                onClick={() => onPickThread(t.id)}
                title="このメールを開く"
              >
                <div className="mail-thread-item-main">
                  <span className="mail-thread-from">{t.fromName ?? t.fromEmail}</span>
                  <span className="mail-thread-subject">{t.subject ?? "(件名なし)"}</span>
                </div>
                <span className="mail-thread-time">
                  {new Date(t.receivedAt).toLocaleString("ja-JP", {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
              </button>
            ))}
          </div>
        );
      })()}

      <ArtifactLinksPanel artifactType="mail" artifactId={String(detail.id)} />
    </div>
  );
}

function ContextMenu(props: {
  x: number;
  y: number;
  item: ListItem;
  hasMultiSelected: boolean;
  checkedCount: number;
  onClose: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onArchive: () => void;
  onTrash: () => void;
  onBatchTrash: () => void;
  onAddVip: () => void;
  onAddBlock: () => void;
  onOpenGmail: () => void;
}) {
  const { x, y, item, hasMultiSelected, checkedCount } = props;
  const ref = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={ref}
      className="mail-ctx-menu"
      style={{ left: x, top: y }}
      onClick={(e) => e.stopPropagation()}
    >
      {hasMultiSelected && (
        <>
          <button onClick={() => { props.onBatchTrash(); props.onClose(); }}>
            選択中 {checkedCount} 件をゴミ箱へ
          </button>
          <div className="mail-ctx-divider" />
        </>
      )}
      <button onClick={() => { props.onToggleRead(); props.onClose(); }}>
        {item.read ? "未読にする" : "既読にする"}
      </button>
      <button onClick={() => { props.onToggleStar(); props.onClose(); }}>
        {item.starred ? "スターを外す" : "スターを付ける"}
      </button>
      <button onClick={() => { props.onArchive(); props.onClose(); }}>
        {item.archived ? "受信箱に戻す" : "アーカイブ"}
      </button>
      <button onClick={() => { props.onTrash(); props.onClose(); }}>
        {item.trashed ? "ゴミ箱から戻す" : "ゴミ箱へ"}
      </button>
      <div className="mail-ctx-divider" />
      <button onClick={() => { props.onAddVip(); props.onClose(); }}>
        VIP に追加 ({item.fromEmail})
      </button>
      <button onClick={() => { props.onAddBlock(); props.onClose(); }}>
        ブロックに追加
      </button>
      <div className="mail-ctx-divider" />
      <button onClick={() => { props.onOpenGmail(); props.onClose(); }}>
        Gmail で開く
      </button>
    </div>
  );
}

/**
 * メール detail の「・・・」 kebab menu。
 *
 * 「TODO に送る」等を押すと /api/intent に source を投げて Gemma に draft 変換させ、
 * 結果を "yui-intent-draft" custom event に乗せて page.tsx 側 listener に
 * 流す → target modal が pre-fill モードで開く。
 *
 * Phase A は TODO 1 個のみ。Event / Contact は Phase B 以降。
 */
function MailKebabMenu({
  detail,
  onOpenTraining,
}: {
  detail: Detail;
  onOpenTraining: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const sendToTarget = async (target: "todo" | "event" | "contact") => {
    if (busy) return;
    setBusy(true);
    setOpen(false);
    try {
      const res = await fetch("/api/intent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          target,
          sourceRefId: String(detail.id),
          source: {
            type: "mail",
            data: {
              subject: detail.subject ?? "",
              from: {
                name: detail.from.name ?? undefined,
                address: detail.from.email,
              },
              to: detail.to.map((address) => ({ address })),
              bodySnippet: (detail.bodyText ?? detail.snippet ?? "").slice(0, 4000),
              receivedAt: detail.receivedAt,
            },
          },
        }),
      });
      const json = (await res.json()) as {
        draft: Record<string, unknown> | null;
        inheritedProjects?: Array<{ id: number; name: string; color: string | null }>;
        inheritedProjectIds?: number[];
        dedupCheck?: { existing: { id: number; identifier: string; title: string } | null };
        warning?: string;
      };
      // 同タイトル active TODO 既存ヒット時は対象 modal を開かず Mail 側トーストで完結
      // (target=todo のみ、他は dedup なし)
      if (target === "todo" && json.dedupCheck?.existing) {
        const e = json.dedupCheck.existing;
        setToast(`既に登録されています: ${e.identifier}「${e.title}」`);
        return;
      }
      window.dispatchEvent(
        new CustomEvent("yui-intent-draft", {
          detail: {
            target,
            draft: json.draft,
            inheritedProjects: json.inheritedProjects ?? [],
            inheritedProjectIds:
              json.inheritedProjectIds ?? (json.inheritedProjects ?? []).map((p) => p.id),
            sourceType: "mail",
            sourceId: String(detail.id),
            warning: json.warning,
            sourceFallback: {
              title: detail.subject ?? "(件名なし)",
              note: `[Mail から] ${detail.from.name ?? detail.from.email}「${detail.subject ?? "(件名なし)"}」\n${detail.snippet ?? ""}`,
            },
          },
        })
      );
    } catch (e) {
      console.warn("[mail-kebab] intent failed:", e);
      setToast("失敗しました (LLM もしくはネットワーク)");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mail-kebab" ref={ref}>
      {toast && (
        <div className="mail-kebab-toast" role="status">
          <span>{toast}</span>
          <button
            type="button"
            className="mail-kebab-toast-close"
            onClick={() => setToast(null)}
            aria-label="閉じる"
          >
            ×
          </button>
        </div>
      )}
      <button
        type="button"
        className="mail-act-btn mail-act-icon"
        onClick={() => setOpen((v) => !v)}
        aria-label="他のツールへ送る"
        title="他のツールへ送る"
        disabled={busy}
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open && (
        <div className="mail-kebab-menu" role="menu">
          <button type="button" className="mail-kebab-item" onClick={() => void sendToTarget("todo")} disabled={busy}>
            {busy ? "Yui が整えています…" : "TODO に送る"}
          </button>
          <button type="button" className="mail-kebab-item" onClick={() => void sendToTarget("event")} disabled={busy}>
            予定に作る
          </button>
          <button type="button" className="mail-kebab-item" onClick={() => void sendToTarget("contact")} disabled={busy}>
            連絡先に登録
          </button>
          <div className="mail-kebab-sep" />
          <button
            type="button"
            className="mail-kebab-item"
            onClick={() => {
              setOpen(false);
              onOpenTraining();
            }}
            disabled={busy}
          >
            {detail.bucket ? "分類を訂正" : "学習させる"}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * メール本文 iframe。
 * sandbox="allow-same-origin" で script 隔離、srcDoc に accent 色 (テーマ追従) を埋め込む。
 * detail 変更 / theme 変更時に accent を読み直す (mount 時のみだと theme 切替後に古い色が残る)。
 */
// 本文中に外部 (https / http) の <img src> が含まれてるかどうか。
// tracking pixel (= 1x1 透明 GIF を https URL で読み込ませて開封検知) を判定するための
// 簡易ヒューリスティック。文字列照合だけなので、属性順や引用符の揺れも拾えるよう緩めに。
function hasRemoteImages(html: string): boolean {
  return /<img\b[^>]*\bsrc=["']?https?:\/\//i.test(html);
}

function MailBodyIframe({ detail }: { detail: Detail }) {
  const [accentRgb, setAccentRgb] = useState(() => readAccentRgb());
  // 既定で外部画像をブロック (= tracking pixel 自動発火を止める)。
  // ご主人様が「このメールだけ外部画像表示」ボタンを押した時だけ true へ。
  // 親が key={detail.id} で remount する設計なので、別メール開いた瞬間 false に戻る。
  const [showRemoteImages, setShowRemoteImages] = useState(false);

  useEffect(() => {
    // detail 変化時に accent を読み直す + theme 変化を監視 (legitimate DOM sync)。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- DOM sync on detail change
    setAccentRgb(readAccentRgb());
    if (typeof window === "undefined") return;
    const obs = new MutationObserver(() => setAccentRgb(readAccentRgb()));
    obs.observe(document.body, { attributes: true, attributeFilter: ["data-theme"] });
    return () => obs.disconnect();
  }, [detail.id]);

  const remoteImagesPresent = !!detail.bodyHtml && hasRemoteImages(detail.bodyHtml);

  if (detail.bodyHtml) {
    return (
      <>
        {remoteImagesPresent && !showRemoteImages && (
          <div className="mail-remote-image-warning">
            <span>外部画像をブロックしました (tracking pixel 防止)。</span>
            <button
              type="button"
              className="mail-remote-image-show"
              onClick={() => setShowRemoteImages(true)}
            >
              このメールの画像を表示
            </button>
          </div>
        )}
        <iframe
          className="mail-detail-iframe"
          srcDoc={buildSafeHtmlDoc(detail.bodyHtml, accentRgb, showRemoteImages)}
          sandbox="allow-same-origin"
          title="本文"
        />
      </>
    );
  }
  if (detail.bodyText) {
    return (
      <iframe
        className="mail-detail-iframe"
        srcDoc={buildSafeHtmlDoc(
          `<pre style="white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,'SF Mono',Menlo,monospace;margin:0">${escapeHtml(detail.bodyText)}</pre>`,
          accentRgb
        )}
        sandbox="allow-same-origin"
        title="本文"
      />
    );
  }
  return null;
}

/**
 * 受信箱の bucket バッジ (重要/要/不要)。
 * - 未分類: 淡色 「未分類」(クリックで学習モーダル)
 * - 分類済: 色付き短文。bucket_confidence < 0.65 は淡色 + (低) ラベル
 * クリックで学習モーダルを開く (= 訂正フロー)。
 */
function BucketBadge({
  bucket,
  confidence,
  reason,
  onClick,
}: {
  bucket: "important" | "needed" | "unneeded" | null;
  confidence: number | null;
  reason: string | null;
  onClick: () => void;
}) {
  const label = bucket === "important" ? "重要" : bucket === "needed" ? "要" : bucket === "unneeded" ? "不要" : "未分類";
  const lowConf = confidence !== null && confidence < 0.65;
  const cls = [
    "mail-row-bucket",
    bucket ? `bucket-${bucket}` : "bucket-unclassified",
    lowConf ? "low-conf" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const title = reason ? `${label}: ${reason}` : "クリックで分類を訂正/学習";
  return (
    <button
      type="button"
      className={cls}
      title={title}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
    >
      {label}
      {lowConf && <span className="mail-row-bucket-lowconf">(低)</span>}
    </button>
  );
}

// --- lucide 準拠の inline SVG アイコン群 ---
function StarIcon({ filled }: { filled?: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" />
    </svg>
  );
}
function ArchiveIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="3" width="20" height="5" rx="1" />
      <path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8" />
      <line x1="10" y1="12" x2="14" y2="12" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2" />
    </svg>
  );
}
function UndoIcon() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="3 7 9 7 9 13" />
      <path d="M20 17a4 4 0 0 0-4-4H3" />
    </svg>
  );
}

function buildQuotedBody(d: Detail): string {
  const body = d.bodyText ?? d.snippet ?? "";
  const quoted = body
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
  const time = new Date(d.receivedAt).toLocaleString("ja-JP");
  return `\n\n--- ${time}、${d.from.name ?? d.from.email} のメッセージ ---\n${quoted}`;
}

function buildForwardBody(d: Detail): string {
  const body = d.bodyText ?? d.snippet ?? "";
  const time = new Date(d.receivedAt).toLocaleString("ja-JP");
  return [
    "",
    "--------- 転送メール ---------",
    `From: ${d.from.name ? `${d.from.name} <${d.from.email}>` : d.from.email}`,
    `Date: ${time}`,
    `Subject: ${d.subject ?? ""}`,
    `To: ${d.to.join(", ")}`,
    "",
    body,
  ].join("\n");
}

function scoreBucket(s: number): "high" | "mid" | "low" | "noise" {
  if (s >= 0.8) return "high";
  if (s >= 0.5) return "mid";
  if (s >= 0.2) return "low";
  return "noise";
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * iframe srcdoc 用に「外部リンクは新窓」「画像は溢れない」だけ仕込んだ wrapper を作る。
 * sandbox="allow-same-origin" のみなので script は走らない。
 *
 * allowRemoteImages:
 *  - false (既定): CSP の img-src は `data:` のみ → tracking pixel (https URL) を blockし、
 *    送信者に開封を知らせない。
 *  - true: 「このメールだけ画像表示」ボタンをユーザが押した時。img-src に https: を追加。
 *  永続設定にはせず、メールを切り替えると親 `key={detail.id}` で remount → 状態リセット。
 */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 親 document の --accent-rgb をクライアント側で読み出す。SSR / theme 未設定時は紫 fallback。 */
function readAccentRgb(): string {
  if (typeof window === "undefined") return "139, 92, 246";
  const v = getComputedStyle(document.body).getPropertyValue("--accent-rgb").trim();
  return v || "139, 92, 246";
}

function buildSafeHtmlDoc(
  html: string,
  accentRgb: string = "139, 92, 246",
  allowRemoteImages: boolean = false,
): string {
  // 多層防御:
  //   1. DOMPurify で <script>/onerror=/javascript:/etc を削除
  //   2. iframe sandbox (= allow-scripts 無し) で万一抜けても script 実行不能
  //   3. CSP meta で inline script / 外部 script を block (= 3 段目の保険)
  // 旧コードは 2 だけに頼ってたので、sandbox flag の 1 回のリグレッションで
  // 受信メールごとの stored XSS になり得た。
  const sanitized = DOMPurify.sanitize(html, {
    // 一般メール HTML で必要な tag のみ許可。<script>/<iframe>/<object>/<embed> 等は除外。
    USE_PROFILES: { html: true },
    // 「style=」属性は許容するが、url() / expression() / javascript: を DOMPurify が中で弾く
    ALLOW_DATA_ATTR: false,
    // 「src=javascript:...」みたいなプロトコル偽装を弾く
    FORBID_ATTR: ["onerror", "onload", "onclick", "onmouseover"],
    FORBID_TAGS: ["script", "iframe", "object", "embed", "base", "form", "input", "button"],
  });

  // <base target="_blank"> でリンクは新窓
  // body padding は text/plain pane (14px) と揃える
  // iframe は親ドキュメントと別 (CSS 変数も継承されない) ので、accent をそのまま埋め込む
  return `<!doctype html><html><head>
<base target="_blank">
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${allowRemoteImages ? "data: https:" : "data:"}; style-src 'unsafe-inline'; font-src https: data:;">
<style>
  html, body { margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Helvetica Neue", "Yu Gothic UI", sans-serif; font-size: 13px; line-height: 1.6; color: #2d2238; padding: 14px; background: #fff; word-break: break-word; }
  img { max-width: 100%; height: auto; }
  a { color: rgb(${accentRgb}); }
  pre, code { font-family: ui-monospace, "SF Mono", Menlo, monospace; }
  table { border-collapse: collapse; max-width: 100%; }
  /* テーマ accent 色の細スクロールバー */
  * { scrollbar-width: thin; scrollbar-color: rgba(${accentRgb}, 0.45) transparent; }
  *::-webkit-scrollbar { width: 6px; height: 6px; }
  *::-webkit-scrollbar-track { background: transparent; }
  *::-webkit-scrollbar-thumb { background: rgba(${accentRgb}, 0.45); border-radius: 6px; }
  *::-webkit-scrollbar-thumb:hover { background: rgba(${accentRgb}, 0.7); }
</style>
</head><body>${sanitized}</body></html>`;
}
