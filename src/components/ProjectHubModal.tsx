"use client";

/**
 * Project Hub Modal — プロジェクト単位の文脈 aggregate dashboard。
 *
 * 構造:
 *   左 sidebar: 全 project リスト (名前 + 色 + 紐付き artifact 数バッジ)
 *   右 pane:    選択 project の hub
 *     - 未完 TODO / 完了 TODO
 *     - 関連メール
 *     - 関連連絡先
 *     - 関連予定 (count のみ、Phase 3.5 で full)
 *     - 関連メモ (将来)
 *
 * 各アイテムクリック → 該当 source modal に project filter 付きでジャンプ
 * (Phase 3.5)。今は count + 抜粋表示のみ。
 *
 * 設計: docs/roadmap.md §6.8 (project-links Phase 3)
 */
import { useCallback, useEffect, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";

type ProjectListItem = {
  id: number;
  name: string;
  color: string | null;
  archived: boolean;
  counts?: {
    todo: number;
    mail: number;
    event: number;
    contact: number;
    memo: number;
  };
};

type HubData = {
  project: {
    id: number;
    name: string;
    color: string | null;
    description: string | null;
    archived: boolean;
  };
  counts: {
    todo: { total: number; by_state: Record<string, number> };
    mail: number;
    event: number;
    contact: number;
    memo: number;
  };
  todos: Array<{
    id: number;
    identifier: string;
    title: string;
    state: "backlog" | "in_progress" | "blocked" | "done" | "cancelled";
    priority: 1 | 2 | 3;
    due_at: string | null;
    completed_at: string | null;
    linked_by: string;
  }>;
  mails: Array<{
    id: number;
    subject: string | null;
    from_name: string | null;
    from_email: string;
    received_at: string;
    starred: boolean;
    archived: boolean;
    trashed: boolean;
    linked_by: string;
  }>;
  events: Array<{
    artifact_id: string;
    linked_by: string;
    summary: string;
    location: string | null;
    start_iso: string | null;
    end_iso: string | null;
    all_day: boolean;
    status: string | null;
  }>;
  contacts: Array<{
    id: number;
    name: string;
    kana: string | null;
    company: string | null;
    role: string | null;
    linked_by: string;
  }>;
};

type Props = {
  open: boolean;
  onClose: () => void;
};

const STATE_LABEL: Record<string, string> = {
  backlog: "未着手",
  in_progress: "進行中",
  blocked: "確認待",
  done: "完了",
  cancelled: "中止",
};

function fmtDate(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export default function ProjectHubModal({ open, onClose }: Props) {
  const { mounted, closing } = useModalTransition(open);
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [hub, setHub] = useState<HubData | null>(null);
  const [loadingList, setLoadingList] = useState(false);
  const [loadingHub, setLoadingHub] = useState(false);
  const [showDoneTodos, setShowDoneTodos] = useState(false);

  // 予定行の「過去/未来」スタイル判定用。render 中の Date.now() を避けるため
  // state に保持し、modal が開いてる間は 60s 毎に tick して境界をまたいだ予定が
  // 自然に grey out する。
  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  useEffect(() => {
    if (!open) return;
    const id = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(id);
  }, [open]);

  // 他 modal へのジャンプ helper。Hub を閉じてから event 発火 →
  // page.tsx 側 listener が該当 modal を開く (project filter 付きで)。
  const jumpTo = useCallback(
    (tool: "todo" | "mail" | "contact" | "calendar", projectName: string | undefined) => {
      onClose();
      window.dispatchEvent(
        new CustomEvent("yui-jump-modal", {
          detail: { tool, projectName },
        })
      );
    },
    [onClose]
  );

  // project 一覧 + 各 project の count を取得
  const reloadList = useCallback(async () => {
    setLoadingList(true);
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { projects: ProjectListItem[] };
      const active = json.projects.filter((p) => !p.archived);
      // 各 project の hub を並列で叩いて counts を充填
      const withCounts = await Promise.all(
        active.map(async (p) => {
          try {
            const r = await fetch(`/api/projects/${p.id}/hub`, { cache: "no-store" });
            if (!r.ok) return p;
            const h = (await r.json()) as HubData;
            return {
              ...p,
              counts: {
                todo: h.counts.todo.total,
                mail: h.counts.mail,
                event: h.counts.event,
                contact: h.counts.contact,
                memo: h.counts.memo,
              },
            };
          } catch {
            return p;
          }
        })
      );
      // total 紐付き artifact 数で降順 (空 project を後ろに)
      withCounts.sort((a, b) => {
        const ta = (a.counts?.todo ?? 0) + (a.counts?.mail ?? 0) +
                   (a.counts?.event ?? 0) + (a.counts?.contact ?? 0);
        const tb = (b.counts?.todo ?? 0) + (b.counts?.mail ?? 0) +
                   (b.counts?.event ?? 0) + (b.counts?.contact ?? 0);
        return tb - ta;
      });
      setProjects(withCounts);
      if (selectedId === null && withCounts.length > 0) {
        setSelectedId(withCounts[0].id);
      }
    } finally {
      setLoadingList(false);
    }
  }, [selectedId]);

  const reloadHub = useCallback(async (projectId: number) => {
    setLoadingHub(true);
    try {
      const res = await fetch(`/api/projects/${projectId}/hub`, { cache: "no-store" });
      if (!res.ok) {
        setHub(null);
        return;
      }
      const json = (await res.json()) as HubData;
      setHub(json);
    } finally {
      setLoadingHub(false);
    }
  }, []);

  useEffect(() => {
    // modal open 時に project 一覧を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open fetch
    if (open) void reloadList();
  }, [open, reloadList]);

  useEffect(() => {
    // selectedId 変化時に hub 詳細を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-change fetch
    if (open && selectedId !== null) void reloadHub(selectedId);
  }, [open, selectedId, reloadHub]);

  if (!mounted) return null;

  return (
    <div
      className={`project-hub-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`project-hub-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-hub-title"
      >
        <button
          type="button"
          className="project-hub-close"
          onClick={onClose}
          aria-label="閉じる"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <line x1="6" y1="6" x2="18" y2="18" />
            <line x1="18" y1="6" x2="6" y2="18" />
          </svg>
        </button>

        <header className="project-hub-header">
          <h1 id="project-hub-title">プロジェクトハブ</h1>
          <p className="project-hub-subtitle">
            プロジェクト単位で紐付いた TODO・メール・人・予定を一覧
          </p>
        </header>

        <div className="project-hub-body">
          <aside className="project-hub-sidebar">
            {loadingList ? (
              <div className="project-hub-loading">読み込み中…</div>
            ) : (
              projects.map((p) => {
                const total =
                  (p.counts?.todo ?? 0) +
                  (p.counts?.mail ?? 0) +
                  (p.counts?.event ?? 0) +
                  (p.counts?.contact ?? 0);
                return (
                  <button
                    key={p.id}
                    type="button"
                    className={`project-hub-side-row ${selectedId === p.id ? "active" : ""}`}
                    onClick={() => setSelectedId(p.id)}
                  >
                    {p.color && (
                      <span
                        className="project-hub-side-dot"
                        style={{ background: p.color }}
                      />
                    )}
                    <span className="project-hub-side-name">{p.name}</span>
                    {total > 0 && (
                      <span className="project-hub-side-count">{total}</span>
                    )}
                  </button>
                );
              })
            )}
          </aside>

          <section className="project-hub-content">
            {loadingHub && !hub ? (
              <div className="project-hub-loading">読み込み中…</div>
            ) : !hub ? (
              <div className="project-hub-empty">
                左から project を選んでください
              </div>
            ) : (
              <>
                <div className="project-hub-meta">
                  <h2>
                    {hub.project.color && (
                      <span
                        className="project-hub-meta-dot"
                        style={{ background: hub.project.color }}
                      />
                    )}
                    {hub.project.name}
                  </h2>
                  {hub.project.description && (
                    <p className="project-hub-meta-desc">{hub.project.description}</p>
                  )}
                </div>

                {/* TODO */}
                <section className="project-hub-section">
                  {(() => {
                    const open = hub.todos.filter((t) => t.state !== "done" && t.state !== "cancelled");
                    const done = hub.todos.filter((t) => t.state === "done");
                    return (
                      <>
                        <h3>
                          <button
                            type="button"
                            className="project-hub-section-link"
                            onClick={() => jumpTo("todo", hub.project.name)}
                            title="TODO モーダルをこの project の filter 付きで開く"
                          >
                            TODO →
                          </button>
                          <span className="project-hub-section-count">
                            {hub.counts.todo.by_state.in_progress > 0 &&
                              `進行中 ${hub.counts.todo.by_state.in_progress} / `}
                            未完 {open.length}
                            {" / 完了 "}{done.length}
                          </span>
                        </h3>
                        {open.length === 0 && done.length === 0 ? (
                          <div className="project-hub-section-empty">
                            紐付き TODO なし
                          </div>
                        ) : (
                          <>
                            {open.length > 0 && (
                              <ul className="project-hub-todo-list">
                                {open.map((t) => (
                                  <li key={t.id} className="project-hub-todo-row">
                                    <span className={`project-hub-todo-state state-${t.state}`}>
                                      {STATE_LABEL[t.state]}
                                    </span>
                                    <span className="project-hub-todo-title">{t.title}</span>
                                    {t.due_at && (
                                      <span className="project-hub-todo-due">{fmtDate(t.due_at)}</span>
                                    )}
                                  </li>
                                ))}
                              </ul>
                            )}
                            {done.length > 0 && (
                              <>
                                <button
                                  type="button"
                                  className="project-hub-collapse-toggle"
                                  onClick={() => setShowDoneTodos((v) => !v)}
                                >
                                  {showDoneTodos ? "▼" : "▶"} 完了 {done.length} 件
                                </button>
                                {showDoneTodos && (
                                  <ul className="project-hub-todo-list project-hub-todo-list-done">
                                    {done.map((t) => (
                                      <li key={t.id} className="project-hub-todo-row">
                                        <span className="project-hub-todo-state state-done">
                                          完了
                                        </span>
                                        <span className="project-hub-todo-title">{t.title}</span>
                                        {t.completed_at && (
                                          <span className="project-hub-todo-due">
                                            {fmtDate(t.completed_at)}
                                          </span>
                                        )}
                                      </li>
                                    ))}
                                  </ul>
                                )}
                              </>
                            )}
                          </>
                        )}
                      </>
                    );
                  })()}
                </section>

                {/* Mail */}
                <section className="project-hub-section">
                  <h3>
                    <button
                      type="button"
                      className="project-hub-section-link"
                      onClick={() => jumpTo("mail", hub.project.name)}
                      title="メール一覧を開く"
                    >
                      メール →
                    </button>
                    <span className="project-hub-section-count">
                      {hub.counts.mail} 件
                    </span>
                  </h3>
                  {hub.mails.length === 0 ? (
                    <div className="project-hub-section-empty">紐付きメールなし</div>
                  ) : (
                    <ul className="project-hub-mail-list">
                      {hub.mails.slice(0, 10).map((m) => (
                        <li key={m.id} className="project-hub-mail-row">
                          <span className="project-hub-mail-from">
                            {m.from_name ?? m.from_email}
                          </span>
                          <span className="project-hub-mail-subject">
                            {m.subject ?? "(件名なし)"}
                          </span>
                          <span className="project-hub-mail-date">
                            {fmtDate(m.received_at)}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* 連絡先 */}
                <section className="project-hub-section">
                  <h3>
                    <button
                      type="button"
                      className="project-hub-section-link"
                      onClick={() => jumpTo("contact", hub.project.name)}
                      title="連絡先を開く"
                    >
                      関連の人 →
                    </button>
                    <span className="project-hub-section-count">
                      {hub.counts.contact} 名
                    </span>
                  </h3>
                  {hub.contacts.length === 0 ? (
                    <div className="project-hub-section-empty">紐付き連絡先なし</div>
                  ) : (
                    <ul className="project-hub-contact-list">
                      {hub.contacts.map((c) => (
                        <li key={c.id} className="project-hub-contact-row">
                          <span className="project-hub-contact-name">{c.name}</span>
                          {c.company && (
                            <span className="project-hub-contact-org">{c.company}</span>
                          )}
                          {c.role && (
                            <span className="project-hub-contact-role">{c.role}</span>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                {/* 予定 */}
                <section className="project-hub-section">
                  <h3>
                    <button
                      type="button"
                      className="project-hub-section-link"
                      onClick={() => jumpTo("calendar", hub.project.name)}
                      title="カレンダーを開く"
                    >
                      予定 →
                    </button>
                    <span className="project-hub-section-count">
                      {hub.counts.event} 件
                    </span>
                  </h3>
                  {hub.events.length === 0 ? (
                    <div className="project-hub-section-empty">紐付き予定なし</div>
                  ) : (
                    <ul className="project-hub-event-list">
                      {hub.events.map((e) => {
                        const startMs = e.start_iso ? new Date(e.start_iso).getTime() : 0;
                        const isPast = startMs > 0 && startMs < nowMs;
                        const dateStr = e.start_iso
                          ? (() => {
                              const d = new Date(e.start_iso);
                              const md = `${d.getMonth() + 1}/${d.getDate()}`;
                              if (e.all_day) return md;
                              const hm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
                              return `${md} ${hm}`;
                            })()
                          : "";
                        return (
                          <li
                            key={e.artifact_id}
                            className={`project-hub-event-row ${isPast ? "is-past" : ""}`}
                          >
                            <span className="project-hub-event-date">{dateStr}</span>
                            <span className="project-hub-event-title">{e.summary}</span>
                            {e.location && (
                              <span className="project-hub-event-loc">{e.location}</span>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </section>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
