"use client";

/**
 * アドレス帳 Modal — TodoModal と同じ game-style 2 ペイン構成。
 *  - ヘッダ: タイトル + 検索バー (虫眼鏡アイコン) + 「+ 新規」
 *  - 左ペイン: 会社ピッカー (大きい accent 名) + state チップ (最近 / 削除済) + 連絡先カード一覧
 *  - 右ペイン: 選択中の連絡先のインライン編集、または CreateForm、または空状態
 *  - 削除はカスタム confirm popup (window.confirm 廃止)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";
import ProjectChipsEditor from "./ProjectChipsEditor";
import ArtifactLinksPanel from "./ArtifactLinksPanel";
import IntentKebabMenu from "./IntentKebabMenu";

type ContactValue = { type?: string; value: string };

type Contact = {
  id: number;
  identifier: string;
  name: string;
  kana: string | null;
  nickname: string | null;
  company: string | null;
  department: string | null;
  role: string | null;
  emails: ContactValue[];
  phones: ContactValue[];
  addresses: ContactValue[];
  urls: string[];
  birthday: string | null;
  tags: string[];
  notes: string | null;
  last_contact_at: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  external_ref: string | null;
};

type CompanyInfo = { name: string; count: number };

const PAGE_SIZE = 50;

function fmtDate(s: string | null): string {
  if (!s) return "-";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s.slice(0, 10);
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = fmt.formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** Intent dispatch (Mail → 連絡先 等) からの pre-fill。open=true 遷移時に
   *  CreateForm を pre-fill 状態で開く。 */
  intentDraft?: {
    name?: string;
    role?: string;
    organization?: string;
    emails?: string[];
    phones?: string[];
    notes?: string;
  } | null;
  /** Intent 経路の出典 source。作成完了後に artifact_links 書く用。 */
  intentSource?: { type: string; id: string } | null;
};

export default function ContactsModal({ open, onClose, intentDraft, intentSource }: Props) {
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [companies, setCompanies] = useState<CompanyInfo[]>([]);
  const [companyFilter, setCompanyFilter] = useState("");
  const [companyPickerOpen, setCompanyPickerOpen] = useState(false);
  const [stats, setStats] = useState<{
    total: number;
    deleted: number;
    recentMonth: number;
    recentWeek: number;
  } | null>(null);
  // TAG 検索 UI は保留中 (2026-05-29)。state と API 連携だけ残す (setter は復活時に再接続)。
  // 参考: TodoModal と同じく、復活時はチップ列 / #tag syntax のいずれかで再導入予定。
  const [tagFilter, _setTagFilter] = useState("");
  const [includeDeleted, setIncludeDeleted] = useState(false);
  const [onlyRecent, setOnlyRecent] = useState(false);

  const [rows, setRows] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(true);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  // intent dispatch から draft が渡ってきたら open=true 遷移時に creating mode へ
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prop-driven mode switch
    if (open && intentDraft) setCreating(true);
  }, [open, intentDraft]);
  const [confirmDelete, setConfirmDelete] = useState<{ identifier: string; name: string } | null>(null);

  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // モーダル open + Esc/scroll lock
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (confirmDelete) setConfirmDelete(null);
        else if (companyPickerOpen) setCompanyPickerOpen(false);
        else onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose, confirmDelete, companyPickerOpen]);

  // 検索 debounce
  useEffect(() => {
    const id = setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  // 会社一覧 (popup ピッカー用)
  const reloadCompanies = useCallback(() => {
    void fetch("/api/contacts/companies")
      .then((r) => r.json())
      .then((d) => setCompanies(d.companies ?? []))
      .catch(() => setCompanies([]));
  }, []);

  // 件数サマリ
  const reloadStats = useCallback(async () => {
    const params = new URLSearchParams();
    if (companyFilter) params.set("company", companyFilter);
    try {
      const res = await fetch(`/api/contacts/stats?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      setStats(data);
    } catch (e) {
      console.warn("[contacts] stats failed:", e);
    }
  }, [companyFilter]);

  useEffect(() => {
    if (!open) return;
    reloadCompanies();
  }, [open, reloadCompanies]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    void reloadStats();
  }, [open, reloadStats]);

  const filterKey = useMemo(
    () => `${qDebounced}|${companyFilter}|${tagFilter}|${includeDeleted ? 1 : 0}|${onlyRecent ? 1 : 0}`,
    [qDebounced, companyFilter, tagFilter, includeDeleted, onlyRecent]
  );

  // 検索 race 対策: filterKey が変わった瞬間に「世代」を 1 進めて、in-flight な
  // 旧 fetch を AbortController で中断 + 後段で世代比較して捨てる。
  // 例: ユーザーが速くタイプして q="あ" → "あい" と変わった場合、旧 "あ" の結果が
  //     後から帰ってきて "あい" の rows を上書きする事故を防ぐ。
  const searchGenRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) return;
    // 旧 in-flight を即座に止める (= 帰ってきても後段で gen ガードで弾かれるが、
    // ネットワーク帯域と DB クエリを早期解放する)
    abortRef.current?.abort();
    abortRef.current = null;
    searchGenRef.current += 1;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- search race reset
    setRows([]);
    setHasMore(true);
    setSelectedId(null);
  }, [filterKey, open]);

  const loadMore = useCallback(
    async (cursor?: { beforeId: number; beforeLc: string | null }) => {
      if (loading) return;
      // 自分の発火世代を固定。後段で「呼ばれた時の gen と今の gen が等しい」を確認して
      // 結果反映するかどうか判定する (= filter が変わっていれば結果は棄却)。
      const myGen = searchGenRef.current;
      // 既存 in-flight をキャンセル (= cursor 付き無限スクロール中の page request も含む)。
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      try {
        const params = new URLSearchParams();
        params.set("limit", String(PAGE_SIZE));
        if (qDebounced) params.set("q", qDebounced);
        if (companyFilter) params.set("company", companyFilter);
        if (tagFilter) params.set("tag", tagFilter);
        if (includeDeleted) params.set("include_deleted", "1");
        if (onlyRecent) params.set("only_recent", "1");
        if (cursor) {
          params.set("before_id", String(cursor.beforeId));
          params.set("before_lc", cursor.beforeLc ?? "");
        }
        const res = await fetch(`/api/contacts?${params.toString()}`, { signal: ctrl.signal });
        // fetch 完了時点で世代が変わってたら結果を捨てる (network race 対策の
        // 最後のガード: AbortController が間に合わずレスポンスが返ってきた場合用)。
        if (myGen !== searchGenRef.current) return;
        if (!res.ok) {
          setHasMore(false);
          return;
        }
        const data = (await res.json()) as { contacts: Contact[] };
        if (myGen !== searchGenRef.current) return;
        const next = data.contacts ?? [];
        if (next.length === 0) setHasMore(false);
        else {
          setRows((prev) => (cursor ? [...prev, ...next] : next));
          if (next.length < PAGE_SIZE) setHasMore(false);
        }
      } catch (e) {
        // AbortError は filter 変化に伴う意図的キャンセルなので無視 (= ログを汚さない)。
        if (e instanceof DOMException && e.name === "AbortError") return;
        if (myGen !== searchGenRef.current) return;
        console.warn("contacts load failed:", e);
        setHasMore(false);
      } finally {
        // 必ず loading=false にする。世代ガードで skip すると abort 済の旧 fetch が
        // loading=true のまま残り、新世代の loadMore が冒頭の `if (loading) return`
        // で永遠に弾かれる事故になる。loading は「fetch in-flight か」の単なる UI 反映なので、
        // 古い世代の fetch が解消したタイミングで OFF にして問題ない。
        setLoading(false);
      }
    },
    [loading, qDebounced, companyFilter, tagFilter, includeDeleted, onlyRecent]
  );

  useEffect(() => {
    if (!open) return;
    if (rows.length === 0 && hasMore && !loading) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- pagination on-empty fetch
      void loadMore(undefined);
    }
  }, [open, rows.length, hasMore, loading, loadMore]);

  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !loading && rows.length > 0) {
          const last = rows[rows.length - 1];
          void loadMore({
            beforeId: last.id,
            beforeLc: last.last_contact_at ?? null,
          });
        }
      },
      { root: null, rootMargin: "200px", threshold: 0 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [hasMore, loading, rows, loadMore]);

  const patchContact = useCallback(
    async (identifier: string, patch: Partial<Contact>) => {
      try {
        const res = await fetch(`/api/contacts/${encodeURIComponent(identifier)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patch),
        });
        if (!res.ok) return;
        setRows((prev) =>
          prev.map((r) =>
            r.identifier === identifier ? ({ ...r, ...patch } as Contact) : r
          )
        );
        // 会社 / 削除フラグが変わったら companies/stats を再取得
        if (patch.company !== undefined) reloadCompanies();
        if (patch.company !== undefined || patch.deleted_at !== undefined) {
          void reloadStats();
        }
      } catch (e) {
        console.warn("patch failed:", e);
      }
    },
    [reloadCompanies, reloadStats]
  );

  const askDelete = useCallback((identifier: string) => {
    const target = rows.find((r) => r.identifier === identifier);
    setConfirmDelete({ identifier, name: target?.name ?? identifier });
  }, [rows]);

  const executeDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const identifier = confirmDelete.identifier;
    setConfirmDelete(null);
    try {
      const res = await fetch(`/api/contacts/${encodeURIComponent(identifier)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        const data = await res.json();
        setRows((prev) =>
          prev.map((r) =>
            r.identifier === identifier
              ? { ...r, deleted_at: data.contact?.deletedAt ?? new Date().toISOString() }
              : r
          )
        );
        if (!includeDeleted) {
          setRows((prev) => prev.filter((r) => r.identifier !== identifier));
          setSelectedId(null);
        }
        void reloadStats();
      }
    } catch (e) {
      console.warn("delete failed:", e);
    }
  }, [confirmDelete, includeDeleted, reloadStats]);

  const restoreRow = useCallback(async (identifier: string) => {
    try {
      const res = await fetch(
        `/api/contacts/${encodeURIComponent(identifier)}/restore`,
        { method: "POST" }
      );
      if (res.ok) {
        setRows((prev) =>
          prev.map((r) =>
            r.identifier === identifier ? { ...r, deleted_at: null } : r
          )
        );
        void reloadStats();
      }
    } catch (e) {
      console.warn("restore failed:", e);
    }
  }, [reloadStats]);

  const createContact = useCallback(
    async (body: { name: string; company?: string; phones?: ContactValue[]; emails?: ContactValue[]; notes?: string }): Promise<{ id: number } | null> => {
      try {
        const res = await fetch("/api/contacts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return null;
        const json = (await res.json()) as { contact?: { id?: number } };
        setRows([]);
        setHasMore(true);
        void reloadStats();
        reloadCompanies();
        return json.contact?.id ? { id: json.contact.id } : { id: 0 };
      } catch (e) {
        console.warn("create failed:", e);
        return null;
      }
    },
    [reloadStats, reloadCompanies]
  );

  const { mounted, closing } = useModalTransition(open);
  if (!mounted) return null;

  const selected = rows.find((r) => r.id === selectedId) ?? null;

  return (
    <div
      className={`contacts-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`contacts-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="contacts-modal-title"
      >
        <button
          type="button"
          className="contacts-modal-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <header className="contacts-modal-header">
          <h1 id="contacts-modal-title">アドレス帳</h1>
          <div className="contacts-search-wrapper">
            <svg
              className="contacts-search-icon"
              viewBox="0 0 24 24"
              width="16"
              height="16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <circle cx="11" cy="11" r="7" />
              <line x1="20" y1="20" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              name="contact-search"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="contacts-filter-input-header"
              aria-label="検索"
            />
          </div>
          <div className="contacts-modal-actions">
            <button
              type="button"
              className="contacts-add-btn"
              onClick={() => {
                setCreating((v) => !v);
                if (!creating) setSelectedId(null);
              }}
            >
              {creating ? "× キャンセル" : "＋ 新規"}
            </button>
          </div>
        </header>

        <div className="contacts-modal-body">
          <div className="contacts-list-pane">
            <div className="contacts-filter">
              <div className="contacts-company-header">
                <button
                  type="button"
                  className="contacts-company-display"
                  onClick={() => setCompanyPickerOpen((v) => !v)}
                  title="会社で絞り込み"
                >
                  {companyFilter === ""
                    ? "すべて"
                    : companyFilter === "__no_company__"
                      ? "会社なし"
                      : companyFilter}
                  <svg
                    className="contacts-company-chevron"
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
                {companyPickerOpen && (
                  <CompanyPickerPopup
                    companies={companies}
                    current={companyFilter}
                    onPick={(v) => {
                      setCompanyFilter(v);
                      setCompanyPickerOpen(false);
                    }}
                    onClose={() => setCompanyPickerOpen(false)}
                  />
                )}
                {stats && (stats.recentMonth > 0 || stats.recentWeek > 0) && (
                  <div className="contacts-done-stats" aria-label="接触サマリ">
                    {stats.recentWeek > 0 && (
                      <span className="contacts-done-stat">
                        今週 <strong>{stats.recentWeek}</strong>
                      </span>
                    )}
                    {stats.recentMonth > 0 && (
                      <span className="contacts-done-stat">
                        今月 <strong>{stats.recentMonth}</strong>
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="contacts-filter-row contacts-filter-states">
                <label className={`contacts-state-chip ${onlyRecent ? "active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={onlyRecent}
                    onChange={() => setOnlyRecent((v) => !v)}
                  />
                  最近接触
                </label>
                <label className={`contacts-state-chip ${includeDeleted ? "active" : ""}`}>
                  <input
                    type="checkbox"
                    checked={includeDeleted}
                    onChange={() => setIncludeDeleted((v) => !v)}
                  />
                  削除済も表示
                </label>
                {stats && (
                  <span className="contacts-total-badge">
                    全 <strong>{stats.total}</strong>
                    {stats.deleted > 0 && includeDeleted && ` (削 ${stats.deleted})`}
                  </span>
                )}
              </div>
            </div>

            <div className="contacts-list">
              {rows.length === 0 && !loading && (
                <div className="contacts-empty">該当する連絡先がありません。</div>
              )}

              {rows.map((c) => (
                <ContactCard
                  key={c.id}
                  contact={c}
                  selected={selectedId === c.id}
                  onClick={() => {
                    setSelectedId(c.id);
                    setCreating(false);
                  }}
                />
              ))}

              <div ref={sentinelRef} />
              {loading && <div className="contacts-loading">読み込み中…</div>}
              {!hasMore && rows.length > 0 && (
                <div className="contacts-end">これ以上ありません</div>
              )}
            </div>
          </div>

          <div className="contacts-detail-pane">
            {creating ? (
              <CreateForm
                defaults={intentDraft ?? undefined}
                onCancel={() => setCreating(false)}
                onCreate={async (b) => {
                  const created = await createContact(b);
                  if (created) {
                    // intent dispatch 経由なら artifact_links に back-link
                    if (intentSource) {
                      try {
                        await fetch("/api/artifact-links", {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({
                            sourceType: intentSource.type,
                            sourceId: intentSource.id,
                            targetType: "contact",
                            targetId: String(created.id),
                            createdBy: "intent",
                          }),
                        });
                      } catch (e) {
                        console.warn("[contacts] artifact_link attach failed:", e);
                      }
                    }
                    setCreating(false);
                  }
                }}
              />
            ) : selected ? (
              <ContactDetailView
                contact={selected}
                onPatch={(p) => patchContact(selected.identifier, p)}
                onAskDelete={() => askDelete(selected.identifier)}
                onRestore={() => restoreRow(selected.identifier)}
              />
            ) : (
              <div className="contacts-detail-empty">
                左のリストから連絡先を選んでください
              </div>
            )}
          </div>
        </div>

        {confirmDelete && (
          <div
            className="confirm-popup-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setConfirmDelete(null);
            }}
          >
            <div className="confirm-popup" role="dialog" aria-modal="true">
              <h2 className="confirm-popup-title">削除の確認</h2>
              <p className="confirm-popup-body">
                <strong className="confirm-popup-target">「{confirmDelete.name}」</strong>
                を削除しますか?
                <br />
                <span className="confirm-popup-note">論理削除のため、後から復元できます。</span>
              </p>
              <div className="confirm-popup-actions">
                <button
                  type="button"
                  className="confirm-cancel-btn"
                  onClick={() => setConfirmDelete(null)}
                >
                  キャンセル
                </button>
                <button
                  type="button"
                  className="confirm-confirm-btn"
                  onClick={() => void executeDelete()}
                  autoFocus
                >
                  削除する
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * 会社切替ミニ popup。左ペインの会社名表示クリックで開く。
 * 「すべて」「会社なし」と全社 (利用件数順) を縦リスト。
 */
function CompanyPickerPopup({
  companies,
  current,
  onPick,
  onClose,
}: {
  companies: CompanyInfo[];
  current: string;
  onPick: (v: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);
  const items: { label: string; value: string; count?: number }[] = [
    { label: "すべて", value: "" },
    { label: "会社なし", value: "__no_company__" },
    ...companies.map((c) => ({ label: c.name, value: c.name, count: c.count })),
  ];
  return (
    <div className="contacts-company-popup" ref={ref} role="dialog">
      <ul className="contacts-company-popup-list">
        {items.map((it) => (
          <li key={it.value}>
            <button
              type="button"
              className={`contacts-company-popup-item ${current === it.value ? "active" : ""}`}
              onClick={() => onPick(it.value)}
            >
              <span className="contacts-company-popup-name">{it.label}</span>
              {typeof it.count === "number" && (
                <span className="contacts-company-popup-count">{it.count}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * 左ペイン: リスト 1 枚カード。クリックで右ペインに詳細表示。
 * 2 列 game-style: アバター (頭文字) + (会社/タグ/最終接触 → 名前)。
 */
function ContactCard({
  contact,
  selected,
  onClick,
}: {
  contact: Contact;
  selected: boolean;
  onClick: () => void;
}) {
  const c = contact;
  const initial = c.name.trim().slice(0, 1) || "?";
  const isDeleted = !!c.deleted_at;
  return (
    <div
      className={`contact-card ${selected ? "selected" : ""} ${isDeleted ? "deleted" : ""}`}
      onClick={onClick}
    >
      <div className="contact-card-avatar" aria-hidden="true">
        {initial}
      </div>
      <div className="contact-card-body">
        <div className="contact-card-meta-line">
          {c.company && <span className="contact-card-company">{c.company}</span>}
          {c.tags.length > 0 && (
            <span className="contact-card-tags">
              {c.tags.map((t) => (
                <span key={t} className="contact-card-tag">{t}</span>
              ))}
            </span>
          )}
          {c.last_contact_at && (
            <span className="contact-card-last">🕒 {fmtDate(c.last_contact_at)}</span>
          )}
          {isDeleted && <span className="contact-card-deleted">削除済</span>}
        </div>
        <div className="contact-card-name">
          {c.name}
          {c.kana && <span className="contact-card-kana">{c.kana}</span>}
        </div>
      </div>
    </div>
  );
}

/**
 * 右ペイン: 選択中の連絡先のインライン編集。
 * 旧 ContactRow の expanded 部分の編集機構をほぼそのまま採用。
 * 600ms debounce で auto-save、blur で即 flush。
 */
function ContactDetailView({
  contact,
  onPatch,
  onAskDelete,
  onRestore,
}: {
  contact: Contact;
  onPatch: (patch: Partial<Contact>) => void;
  onAskDelete: () => void;
  onRestore: () => void;
}) {
  const c = contact;
  const isDeleted = !!c.deleted_at;

  const [name, setName] = useState(c.name);
  const [kana, setKana] = useState(c.kana ?? "");
  const [nickname, setNickname] = useState(c.nickname ?? "");
  const [company, setCompany] = useState(c.company ?? "");
  const [department, setDepartment] = useState(c.department ?? "");
  const [role, setRole] = useState(c.role ?? "");
  const [birthday, setBirthday] = useState(c.birthday ?? "");
  const [notes, setNotes] = useState(c.notes ?? "");
  const [tagInput, setTagInput] = useState("");

  // c prop 変化時に編集中の値を同期。anti-pattern #4 (key prop) follow-up。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setName(c.name);
    setKana(c.kana ?? "");
    setNickname(c.nickname ?? "");
    setCompany(c.company ?? "");
    setDepartment(c.department ?? "");
    setRole(c.role ?? "");
    setBirthday(c.birthday ?? "");
    setNotes(c.notes ?? "");
  }, [c.id, c.name, c.kana, c.nickname, c.company, c.department, c.role, c.birthday, c.notes]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const pendingSavesRef = useRef<Map<string, () => void>>(new Map());
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const scheduleSave = (key: string, fn: () => void) => {
    const old = timersRef.current.get(key);
    if (old) clearTimeout(old);
    pendingSavesRef.current.set(key, fn);
    const t = setTimeout(() => {
      fn();
      timersRef.current.delete(key);
      pendingSavesRef.current.delete(key);
    }, 600);
    timersRef.current.set(key, t);
  };
  const flushSave = (key: string) => {
    const t = timersRef.current.get(key);
    if (t) {
      clearTimeout(t);
      timersRef.current.delete(key);
    }
    const fn = pendingSavesRef.current.get(key);
    if (fn) {
      fn();
      pendingSavesRef.current.delete(key);
    }
  };
  useEffect(() => {
    const timers = timersRef.current;
    const pendings = pendingSavesRef.current;
    return () => {
      for (const t of timers.values()) clearTimeout(t);
      for (const fn of pendings.values()) fn();
      timers.clear();
      pendings.clear();
    };
  }, []);

  const addArrayItem = (
    field: "phones" | "emails" | "addresses",
    item: ContactValue
  ) => {
    if (!item.value.trim()) return;
    const cur = c[field];
    if (cur.some((x) => x.value === item.value)) return;
    onPatch({ [field]: [...cur, item] } as Partial<Contact>);
  };
  const updateArrayItem = (
    field: "phones" | "emails" | "addresses",
    idx: number,
    newItem: ContactValue
  ) => {
    const cur = c[field];
    const next = cur.map((x, i) => (i === idx ? newItem : x));
    onPatch({ [field]: next } as Partial<Contact>);
  };
  const removeArrayItem = (field: "phones" | "emails" | "addresses", idx: number) => {
    const cur = c[field];
    onPatch({ [field]: cur.filter((_, i) => i !== idx) } as Partial<Contact>);
  };

  const addTag = () => {
    const v = tagInput.trim();
    if (!v || c.tags.includes(v)) return;
    onPatch({ tags: [...c.tags, v] });
    setTagInput("");
  };
  const removeTag = (t: string) => {
    onPatch({ tags: c.tags.filter((x) => x !== t) });
  };

  return (
    <div className={`contact-detail ${isDeleted ? "deleted" : ""}`}>
      <div className="contact-detail-header">
        <input
          name="contact-name"
          className="contact-detail-name-input"
          value={name}
          onChange={(e) => {
            const v = e.target.value;
            setName(v);
            scheduleSave("name", () => onPatch({ name: v }));
          }}
          onBlur={() => flushSave("name")}
          placeholder="名前"
        />
        <input
          name="contact-kana"
          className="contact-detail-kana-input"
          value={kana}
          onChange={(e) => {
            const v = e.target.value;
            setKana(v);
            scheduleSave("kana", () => onPatch({ kana: v }));
          }}
          onBlur={() => flushSave("kana")}
          placeholder="フリガナ"
        />
      </div>

      <ProjectChipsEditor
        artifactType="contact"
        artifactId={String(c.id)}
        artifactPayload={{
          type: "contact",
          data: {
            name: c.name,
            organization: c.company ?? undefined,
            role: c.role ?? undefined,
            emails: c.emails.map((e) => e.value),
            phones: c.phones.map((p) => p.value),
            notes: c.notes ?? undefined,
          },
        }}
        label="プロジェクト"
      />

      <div className="contact-edit-grid">
        <label className="contact-edit-label">
          <span>ニックネーム</span>
          <input
            name="contact-nickname"
            value={nickname}
            onChange={(e) => {
              const v = e.target.value;
              setNickname(v);
              scheduleSave("nickname", () => onPatch({ nickname: v }));
            }}
            onBlur={() => flushSave("nickname")}
          />
        </label>
        <label className="contact-edit-label">
          <span>誕生日</span>
          <input
            name="contact-birthday"
            type="date"
            value={birthday ? birthday.slice(0, 10) : ""}
            onChange={(e) => {
              const v = e.target.value;
              setBirthday(v);
              scheduleSave("birthday", () => onPatch({ birthday: v || null }));
            }}
            onBlur={() => flushSave("birthday")}
          />
        </label>
        <label className="contact-edit-label">
          <span>会社</span>
          <input
            name="contact-company"
            value={company}
            onChange={(e) => {
              const v = e.target.value;
              setCompany(v);
              scheduleSave("company", () => onPatch({ company: v }));
            }}
            onBlur={() => flushSave("company")}
          />
        </label>
        <label className="contact-edit-label">
          <span>部署</span>
          <input
            name="contact-department"
            value={department}
            onChange={(e) => {
              const v = e.target.value;
              setDepartment(v);
              scheduleSave("department", () => onPatch({ department: v }));
            }}
            onBlur={() => flushSave("department")}
          />
        </label>
        <label className="contact-edit-label contact-edit-wide">
          <span>役職 / 関係性</span>
          <input
            name="contact-role"
            value={role}
            onChange={(e) => {
              const v = e.target.value;
              setRole(v);
              scheduleSave("role", () => onPatch({ role: v }));
            }}
            onBlur={() => flushSave("role")}
          />
        </label>

        <ArrayField
          field="phones"
          label="☎ 電話"
          items={c.phones}
          onAdd={(v) => addArrayItem("phones", v)}
          onUpdate={(i, v) => updateArrayItem("phones", i, v)}
          onRemove={(i) => removeArrayItem("phones", i)}
        />
        <ArrayField
          field="emails"
          label="✉ メール"
          items={c.emails}
          onAdd={(v) => addArrayItem("emails", v)}
          onUpdate={(i, v) => updateArrayItem("emails", i, v)}
          onRemove={(i) => removeArrayItem("emails", i)}
        />
        <ArrayField
          field="addresses"
          label="🏠 住所"
          items={c.addresses}
          onAdd={(v) => addArrayItem("addresses", v)}
          onUpdate={(i, v) => updateArrayItem("addresses", i, v)}
          onRemove={(i) => removeArrayItem("addresses", i)}
        />

        <label className="contact-edit-label contact-edit-wide">
          <span>タグ</span>
          <div className="contact-edit-tags">
            {c.tags.map((t) => (
              <span key={t} className="contact-tag-chip">
                {t}
                <button
                  type="button"
                  className="contact-tag-chip-x"
                  onClick={() => removeTag(t)}
                  aria-label={`${t} 削除`}
                >×</button>
              </span>
            ))}
            <input
              name="contact-tag"
              className="contact-tag-input"
              value={tagInput}
              onChange={(e) => setTagInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === ",") {
                  e.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
              placeholder="+ タグ"
            />
          </div>
        </label>

        <label className="contact-edit-label contact-edit-wide contact-edit-memo">
          <span>メモ</span>
          <textarea
            name="contact-notes"
            value={notes}
            onChange={(e) => {
              const v = e.target.value;
              setNotes(v);
              scheduleSave("notes", () => onPatch({ notes: v }));
            }}
            onBlur={() => flushSave("notes")}
            rows={5}
          />
        </label>
      </div>

      <div className="contact-detail-actions">
        {c.emails.length > 0 && (
          <button
            type="button"
            className="contact-action-btn"
            onClick={() => {
              const firstEmail = c.emails[0]?.value;
              if (!firstEmail) return;
              window.dispatchEvent(
                new CustomEvent("yui-open-compose", {
                  detail: { toPrefill: [firstEmail] },
                })
              );
            }}
            title="このメールアドレスにメールを書く"
          >
            メール送信
          </button>
        )}
        <IntentKebabMenu
          sourceRefId={String(c.id)}
          sourcePayload={{
            type: "contact",
            data: {
              name: c.name,
              organization: c.company ?? undefined,
              role: c.role ?? undefined,
              emails: c.emails.map((e) => e.value),
              phones: c.phones.map((p) => p.value),
              notes: c.notes ?? undefined,
            },
          }}
          targets={["todo", "event"]}
          position="left"
        />
      </div>

      <ArtifactLinksPanel artifactType="contact" artifactId={String(c.id)} />

      <div className="contact-detail-foot">
        <div className="contact-meta-foot">
          {c.external_ref && <span>外部参照: {c.external_ref}</span>}
          <span>登録: {fmtDate(c.created_at)}</span>
          {c.last_contact_at && <span>最終接触: {fmtDate(c.last_contact_at)}</span>}
        </div>
        {isDeleted ? (
          <button type="button" className="contact-restore-btn" onClick={onRestore}>
            復元
          </button>
        ) : (
          <button type="button" className="contact-delete-btn" onClick={onAskDelete}>
            削除
          </button>
        )}
      </div>
    </div>
  );
}

function ArrayItemRow({
  item,
  onUpdate,
  onRemove,
}: {
  item: ContactValue;
  onUpdate: (v: ContactValue) => void;
  onRemove: () => void;
}) {
  const [type, setType] = useState(item.type ?? "");
  const [value, setValue] = useState(item.value);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<(() => void) | null>(null);

  // item prop 変化時に編集中の値を同期。anti-pattern #4 follow-up。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setType(item.type ?? "");
    setValue(item.value);
  }, [item.type, item.value]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const schedule = (fn: () => void) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    pendingRef.current = fn;
    timerRef.current = setTimeout(() => {
      fn();
      pendingRef.current = null;
      timerRef.current = null;
    }, 600);
  };
  const flush = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (pendingRef.current) {
      pendingRef.current();
      pendingRef.current = null;
    }
  };
  useEffect(() => {
    const timer = timerRef.current;
    const pending = pendingRef.current;
    return () => {
      if (timer) clearTimeout(timer);
      if (pending) pending();
    };
  }, []);

  return (
    <div className="contact-array-row">
      <input
        name="contact-array-type"
        className="contact-array-type"
        value={type}
        onChange={(e) => {
          const v = e.target.value;
          setType(v);
          schedule(() => onUpdate({ ...item, type: v || undefined, value }));
        }}
        onBlur={flush}
        placeholder="type"
      />
      <input
        name="contact-array-value"
        className="contact-array-value"
        value={value}
        onChange={(e) => {
          const v = e.target.value;
          setValue(v);
          schedule(() => onUpdate({ ...item, type: type || undefined, value: v }));
        }}
        onBlur={flush}
      />
      <button type="button" className="contact-array-del" onClick={onRemove}>
        ×
      </button>
    </div>
  );
}

function ArrayField({
  field,
  label,
  items,
  onAdd,
  onUpdate,
  onRemove,
}: {
  field: "phones" | "emails" | "addresses";
  label: string;
  items: ContactValue[];
  onAdd: (v: ContactValue) => void;
  onUpdate: (i: number, v: ContactValue) => void;
  onRemove: (i: number) => void;
}) {
  const [newType, setNewType] = useState("");
  const [newValue, setNewValue] = useState("");
  return (
    <div className="contact-edit-label contact-edit-wide">
      <span>{label}</span>
      <div className="contact-array-list">
        {items.map((item, i) => (
          <ArrayItemRow
            key={i}
            item={item}
            onUpdate={(v) => onUpdate(i, v)}
            onRemove={() => onRemove(i)}
          />
        ))}
        <div className="contact-array-row contact-array-add">
          <input
            name="contact-array-type"
            className="contact-array-type"
            value={newType}
            onChange={(e) => setNewType(e.target.value)}
            placeholder={field === "phones" ? "cell" : field === "emails" ? "work" : "home"}
          />
          <input
            name="contact-array-value"
            className="contact-array-value"
            value={newValue}
            onChange={(e) => setNewValue(e.target.value)}
            placeholder="値を入力して Enter"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (newValue.trim()) {
                  onAdd({ type: newType || undefined, value: newValue.trim() });
                  setNewType("");
                  setNewValue("");
                }
              }
            }}
          />
          <button
            type="button"
            className="contact-array-add-btn"
            onClick={() => {
              if (newValue.trim()) {
                onAdd({ type: newType || undefined, value: newValue.trim() });
                setNewType("");
                setNewValue("");
              }
            }}
          >
            +
          </button>
        </div>
      </div>
    </div>
  );
}

function CreateForm({
  defaults,
  onCancel,
  onCreate,
}: {
  /** Intent dispatch 経由の pre-fill */
  defaults?: {
    name?: string;
    role?: string;
    organization?: string;
    emails?: string[];
    phones?: string[];
    notes?: string;
  };
  onCancel: () => void;
  onCreate: (b: { name: string; company?: string; phones?: ContactValue[]; emails?: ContactValue[]; notes?: string }) => Promise<void>;
}) {
  const [name, setName] = useState(defaults?.name ?? "");
  const [company, setCompany] = useState(defaults?.organization ?? "");
  const [phone, setPhone] = useState(defaults?.phones?.[0] ?? "");
  const [email, setEmail] = useState(defaults?.emails?.[0] ?? "");
  const [notes, setNotes] = useState(defaults?.notes ?? "");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!name.trim()) return;
    setSubmitting(true);
    try {
      await onCreate({
        name: name.trim(),
        company: company.trim() || undefined,
        phones: phone.trim() ? [{ value: phone.trim() }] : undefined,
        emails: email.trim() ? [{ value: email.trim() }] : undefined,
        notes: notes.trim() || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="contact-create">
      <h3>新規連絡先</h3>
      <div className="contact-edit-grid">
        <label className="contact-edit-label contact-edit-wide">
          <span>名前 (必須)</span>
          <input name="new-contact-name" value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </label>
        <label className="contact-edit-label">
          <span>会社</span>
          <input name="new-contact-company" value={company} onChange={(e) => setCompany(e.target.value)} />
        </label>
        <label className="contact-edit-label">
          <span>電話 1 件</span>
          <input name="new-contact-phone" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="後で複数追加可" />
        </label>
        <label className="contact-edit-label contact-edit-wide">
          <span>メール 1 件</span>
          <input name="new-contact-email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="後で複数追加可" />
        </label>
        <label className="contact-edit-label contact-edit-wide">
          <span>メモ</span>
          <textarea name="new-contact-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} />
        </label>
      </div>
      <div className="contact-detail-foot">
        <button type="button" className="contact-cancel-btn" onClick={onCancel}>
          キャンセル
        </button>
        <button type="button" className="contact-save-btn" onClick={submit} disabled={!name.trim() || submitting}>
          {submitting ? "作成中…" : "作成"}
        </button>
      </div>
    </div>
  );
}
