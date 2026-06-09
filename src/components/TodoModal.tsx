"use client";

/**
 * TODO Modal — IconBar の TODO ボタンから開く。
 *
 * 機能:
 *   - フィルタ: project (dropdown) / tag (text) / state (multi checkbox) / search (text)
 *   - 期限超過 / 今月 / 来月以降 / 期限なし のグループ別表示
 *   - 無限スクロール (IntersectionObserver)
 *   - 行クリックで詳細展開 → インライン編集 (state / priority / title / project / tags / note / 期日 / URL / 見積)
 *   - 各フィールドは debounce 保存、state/priority/削除は即時保存
 *   - "+ 新規" で空フォーム → 保存で list 先頭に追加
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModalTransition } from "@/lib/useModalTransition";
import ProjectChipsEditor from "./ProjectChipsEditor";
import ProjectChips from "./ProjectChips";
import ArtifactLinksPanel from "./ArtifactLinksPanel";
import IntentKebabMenu from "./IntentKebabMenu";
import MiniReminderForm from "./MiniReminderForm";

type ProjectInfo = {
  id: number;
  name: string;
  color: string | null;
  archived: boolean;
};

type TodoState = "backlog" | "in_progress" | "blocked" | "done";

type LinkedProject = {
  id: number;
  name: string;
  color: string | null;
  linked_by: string; // "primary" | "manual" | "ai" | "intent"
};

type TodoRow = {
  id: number;
  identifier: string;
  title: string;
  note: string | null;
  url: string | null;
  state: TodoState;
  priority: 1 | 2 | 3;
  tags: string[];
  start_at: string | null;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
  external_ref: string | null;
  project_id: number | null;
  linked_projects: LinkedProject[];
  project_name: string | null;
  project_color: string | null;
};

const STATES: TodoState[] = ["backlog", "in_progress", "blocked", "done"];

const STATE_LABEL: Record<TodoState, string> = {
  backlog: "未着手",
  in_progress: "進行中",
  blocked: "確認待",
  done: "完了",
};
const PRIORITY_LABEL: Record<number, string> = { 1: "低", 2: "中", 3: "高" };

/** IconBar と同じテイスト (line stroke, 2px) の状態アイコン。 */
function StateIcon({ state, size = 14 }: { state: TodoState; size?: number }) {
  const sw = 2;
  const svgProps = {
    viewBox: "0 0 24 24",
    width: size,
    height: size,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: sw,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  switch (state) {
    case "backlog":
      // 未着手はアイコンなし (テキストのみで簡潔に)
      return null;
    case "in_progress":
      return (
        <svg {...svgProps} fill="currentColor" stroke="none">
          <polygon points="7 5 20 12 7 19" />
        </svg>
      );
    case "blocked":
      return (
        <svg {...svgProps}>
          <circle cx={12} cy={12} r={9} />
          <line x1={6.5} y1={6.5} x2={17.5} y2={17.5} />
        </svg>
      );
    case "done":
      return (
        <svg {...svgProps}>
          <polyline points="20 7 10 18 4 12.5" />
        </svg>
      );
  }
}

/** 優先度 = signal-bars 風 (1 / 2 / 3 段)。アクティブ段は塗りつぶし、それ以下は淡く。
    各 bar は viewBox の中心 (y=12) を基準に上下対称に描いて、chip 内のテキストと
    視覚的に揃うようにする (本物のアンテナマークの「底揃え」ではなく中央揃え)。 */
function PriorityIcon({ priority, size = 14 }: { priority: 1 | 2 | 3; size?: number }) {
  const bars: Array<{ x: number; h: number }> = [
    { x: 4, h: 7 },
    { x: 11, h: 12 },
    { x: 18, h: 17 },
  ];
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      stroke="none"
      aria-hidden="true"
    >
      {bars.map((b, i) => (
        <rect
          key={i}
          x={b.x}
          y={12 - b.h / 2}
          width={3}
          height={b.h}
          rx={1}
          fillOpacity={priority >= i + 1 ? 1 : 0.2}
        />
      ))}
    </svg>
  );
}

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

/** 「2026年6月1日(月)」のような日本語表記。空入力は "—" を返す。 */
function fmtDateJa(s: string): string {
  if (!s) return "—";
  // s は date input value (YYYY-MM-DD) もしくは ISO 文字列
  const ymd = s.length >= 10 ? s.slice(0, 10) : s;
  const d = new Date(`${ymd}T00:00:00.000+09:00`);
  if (Number.isNaN(d.getTime())) return s;
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "long",
    day: "numeric",
    weekday: "short",
  })
    .format(d)
    .replace(/\(/g, "(")
    .replace(/\)/g, ")");
}
function toDateInputValue(s: string | null | undefined): string {
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
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
function dateInputToIso(s: string): string | null {
  if (!s) return null;
  const d = new Date(s + "T00:00:00.000+09:00");
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

function MiniCalendar({
  value,
  onChange,
  onClose,
}: {
  value: string; // YYYY-MM-DD or ""
  onChange: (v: string) => void;
  onClose: () => void;
}) {
  const today = useMemo(() => {
    const d = new Date();
    return {
      y: d.getFullYear(),
      m: d.getMonth() + 1,
      ymd: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
    };
  }, []);
  const initial = value && value.length >= 10
    ? { y: Number(value.slice(0, 4)), m: Number(value.slice(5, 7)) }
    : { y: today.y, m: today.m };
  const [year, setYear] = useState(initial.y);
  const [month, setMonth] = useState(initial.m);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const grid = useMemo(() => {
    const first = new Date(year, month - 1, 1);
    const startDow = first.getDay();
    const cells: { ymd: string; inMonth: boolean; day: number }[] = [];
    for (let i = 0; i < 42; i++) {
      const d = new Date(year, month - 1, 1 + (i - startDow));
      const ymd = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      cells.push({ ymd, inMonth: d.getMonth() === month - 1, day: d.getDate() });
    }
    return cells;
  }, [year, month]);

  const nav = (delta: number) => {
    let y = year;
    let m = month + delta;
    while (m < 1) { y--; m += 12; }
    while (m > 12) { y++; m -= 12; }
    setYear(y);
    setMonth(m);
  };

  return (
    <div className="mini-calendar" ref={ref} role="dialog">
      <div className="mini-calendar-head">
        <button type="button" className="mini-calendar-nav" onClick={() => nav(-1)} aria-label="前月">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <span className="mini-calendar-title">{year}年{month}月</span>
        <button type="button" className="mini-calendar-nav" onClick={() => nav(1)} aria-label="翌月">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
      </div>
      <div className="mini-calendar-weekdays">
        {["日", "月", "火", "水", "木", "金", "土"].map((w, i) => (
          <div key={w} className={`mini-calendar-weekday ${i === 0 ? "sun" : i === 6 ? "sat" : ""}`}>
            {w}
          </div>
        ))}
      </div>
      <div className="mini-calendar-grid">
        {grid.map((cell, i) => {
          const dow = i % 7;
          const isSel = cell.ymd === value;
          const isToday = cell.ymd === today.ymd;
          return (
            <button
              key={`${cell.ymd}-${i}`}
              type="button"
              className={`mini-calendar-cell ${cell.inMonth ? "" : "out"} ${isSel ? "selected" : ""} ${isToday ? "today" : ""} ${dow === 0 ? "sun" : dow === 6 ? "sat" : ""}`}
              onClick={() => onChange(cell.ymd)}
            >
              {cell.day}
            </button>
          );
        })}
      </div>
      <div className="mini-calendar-foot">
        <button type="button" className="mini-calendar-quick" onClick={() => onChange(today.ymd)}>
          今日
        </button>
        <button type="button" className="mini-calendar-clear" onClick={() => onChange("")}>
          クリア
        </button>
      </div>
    </div>
  );
}

function bucketOf(due: string | null): "overdue" | "thisMonth" | "future" | "noDue" {
  if (!due) return "noDue";
  const d = new Date(due);
  const now = new Date();
  if (d < now) return "overdue";
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59);
  if (d <= monthEnd) return "thisMonth";
  return "future";
}

type Props = {
  open: boolean;
  onClose: () => void;
  /** Hub modal などからジャンプしてきた時の project filter 初期値 (project name) */
  initialProjectFilter?: string | null;
  /** Intent dispatch (mail → TODO 等) で渡される作成 form pre-fill */
  intentDraft?: {
    title?: string;
    note?: string;
    dueIso?: string;
    tags?: string[];
  } | null;
  /** 同 dispatch で渡される継承候補 project 配列。1 つ目を primary project に
   *  pre-fill、残りは作成後 auto-attach (project_links に linked_by="intent" で) */
  intentInheritedProjects?: Array<{ id: number; name: string; color: string | null }>;
  /** Intent dispatch の出典 source (Mail から作られた場合: {type:"mail", id:"..."})。
   *  /api/todos POST 時に source として送る → サーバが artifact_links に書く。 */
  intentSource?: { type: string; id: string } | null;
};

export default function TodoModal({
  open,
  onClose,
  initialProjectFilter,
  intentDraft: intentDraftProp,
  intentInheritedProjects: intentInheritsProp,
  intentSource: intentSourceProp,
}: Props) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectFilter, setProjectFilter] = useState<string>("");
  // open=true への遷移時、外部から渡された initial filter を適用
  useEffect(() => {
    if (open && initialProjectFilter !== undefined && initialProjectFilter !== null) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prop-driven filter init
      setProjectFilter(initialProjectFilter);
    }
  }, [open, initialProjectFilter]);
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  // TAG 検索 UI は保留中 (2026-05-29)。プロジェクトヘッダ刷新時に input を撤去し、
  // 表示方法 (チップ列 / #tag syntax / 別) を未決のまま state と API 連携だけ残してある。
  // setter (_setTagFilter) を呼ぶ呼び出し元が復活した時点で UI も再導入する想定。
  // 参考: タグ列の入る余地は state チップ行右の余白、または検索バー (#tag) 案あり。
  const [tagFilter, _setTagFilter] = useState<string>("");
  // プロジェクト別の TODO 件数サマリ。state チップ脇とフィルタ行末に表示。
  const [stats, setStats] = useState<{
    byState: { backlog: number; in_progress: number; blocked: number; done: number };
    doneToday: number;
    doneThisWeek: number;
  } | null>(null);
  const [stateFilter, setStateFilter] = useState<Set<TodoState>>(
    new Set<TodoState>(["backlog", "in_progress", "blocked"])
  );
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");

  const [rows, setRows] = useState<TodoRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [addReminderTo, setAddReminderTo] = useState<TodoRow | null>(null);
  // sessionId は SSR セーフな lazy init で取り込む。
  const [sessionId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      return localStorage.getItem("vroid-chat-session-id");
    } catch {
      return null;
    }
  });
  // page.tsx 経由で intent draft + 継承 project を受け取る (props)。
  // open=true 遷移時に creating mode に入って CreateForm を pre-fill 表示する。
  const intentDraft = intentDraftProp ?? null;
  // `?? []` で新しい array を毎レンダー生成すると後段の useCallback deps が
  // 毎回変わってしまうので useMemo で固定。
  const intentInheritedProjects = useMemo<Array<{ id: number; name: string; color: string | null }>>(
    () => intentInheritsProp ?? [],
    [intentInheritsProp],
  );
  const intentSource = intentSourceProp ?? null;
  // 重複 TODO を作った後に表示する「既に登録されています」notice。auto-dismiss。
  const [dupNotice, setDupNotice] = useState<{ identifier: string; title: string } | null>(null);
  useEffect(() => {
    if (!dupNotice) return;
    const t = setTimeout(() => setDupNotice(null), 5000);
    return () => clearTimeout(t);
  }, [dupNotice]);
  useEffect(() => {
    if (open && intentDraft) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- prop-driven mode switch
      setCreating(true);
    }
  }, [open, intentDraft]);

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

  // open 時に projects 読み込み
  const reloadProjects = useCallback(() => {
    void fetch("/api/projects")
      .then((r) => r.json())
      .then((d) => setProjects(d.projects ?? []))
      .catch(() => setProjects([]));
  }, []);

  useEffect(() => {
    if (!open) return;
    reloadProjects();
  }, [open, reloadProjects]);

  // プロジェクト切替 / モーダル open のたびに件数サマリを再取得
  const reloadStats = useCallback(async () => {
    const params = new URLSearchParams();
    if (projectFilter) params.set("project", projectFilter);
    try {
      const res = await fetch(`/api/todos/stats?${params.toString()}`);
      if (!res.ok) return;
      const data = await res.json();
      setStats(data);
    } catch (e) {
      console.warn("[todos] stats load failed:", e);
    }
  }, [projectFilter]);
  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open stats fetch
    void reloadStats();
  }, [open, reloadStats]);

  useEffect(() => {
    const id = setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const filterKey = useMemo(
    () =>
      `${projectFilter}|${tagFilter}|${Array.from(stateFilter).sort().join(",")}|${qDebounced}`,
    [projectFilter, tagFilter, stateFilter, qDebounced]
  );

  // filterKey 変化時に旧結果をクリア (= 新しいフィルタの結果と混ざらないように)。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    if (!open) return;
    setRows([]);
    setExpandedId(null);
  }, [filterKey, open]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // 全件 1 ショット fetch。グループ別表示 (期限超過 / 今月末まで / 来月以降 / 期限なし)
  // が "ロード済みの中での" 部分集計になっていた旧設計を撤廃。フィルタ単位で全件
  // (server cap 1000) を一度に取って正しいグルーピングを担保する。
  const reloadAll = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("limit", "1000");
      if (projectFilter) params.set("project", projectFilter);
      if (tagFilter) params.set("tag", tagFilter);
      if (stateFilter.size > 0) {
        params.set("states", Array.from(stateFilter).join(","));
      }
      if (qDebounced) params.set("q", qDebounced);
      const res = await fetch(`/api/todos?${params.toString()}`);
      if (!res.ok) {
        setRows([]);
        return;
      }
      const data = (await res.json()) as { todos: TodoRow[] };
      setRows(data.todos ?? []);
    } catch (e) {
      console.warn("todos load failed:", e);
      setRows([]);
    } finally {
      setLoading(false);
    }
  }, [projectFilter, tagFilter, stateFilter, qDebounced]);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-open/filter fetch
    void reloadAll();
  }, [open, reloadAll]);

  const grouped = useMemo(() => {
    const g = {
      overdue: [] as TodoRow[],
      thisMonth: [] as TodoRow[],
      future: [] as TodoRow[],
      noDue: [] as TodoRow[],
      done: [] as TodoRow[],
    };
    for (const r of rows) {
      if (r.state === "done") g.done.push(r);
      else g[bucketOf(r.due_at)].push(r);
    }
    return g;
  }, [rows]);

  const toggleState = (s: TodoState) => {
    setStateFilter((prev) => {
      const next = new Set(prev);
      if (next.has(s)) next.delete(s);
      else next.add(s);
      return next;
    });
  };

  // 単一 todo の部分更新 (API call + ローカル state 同期)
  const patchTodo = useCallback(
    async (identifier: string, patch: Partial<TodoRow> & { project?: string | null }) => {
      // project は文字列なので変換
      const body: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (k === "project") body.project = v;
        else if (k === "start_at" || k === "due_at") body[k] = v;
        else body[k] = v;
      }
      try {
        const res = await fetch(`/api/todos/${encodeURIComponent(identifier)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) return;
        // 更新後の整合性は次回 reload に任せる。今は楽観的更新。
        setRows((prev) =>
          prev.map((r) =>
            r.identifier === identifier
              ? {
                  ...r,
                  ...patch,
                  project_name: patch.project !== undefined ? (patch.project ?? null) as string | null : r.project_name,
                } as TodoRow
              : r
          )
        );
        // project 新規作成された可能性 → projects refresh
        if (patch.project) reloadProjects();
        // state や所属プロジェクトが変わった → 件数サマリも更新
        if (patch.state !== undefined || patch.project !== undefined) {
          void reloadStats();
        }
      } catch (e) {
        console.warn("patch failed:", e);
      }
    },
    [reloadProjects, reloadStats]
  );

  // 削除確認 popup (window.confirm の代わりにテイストを揃えた custom UI)。
  // identifier だけでなく title も保持しておくと「○○ を削除しますか?」と
  // 識別子に頼らない自然な文言になる。
  const [confirmDelete, setConfirmDelete] = useState<{
    identifier: string;
    title: string;
  } | null>(null);

  const askDelete = useCallback((identifier: string) => {
    setRows((prev) => {
      const target = prev.find((r) => r.identifier === identifier);
      if (target) {
        setConfirmDelete({ identifier, title: target.title });
      }
      return prev;
    });
  }, []);

  const executeDelete = useCallback(async () => {
    if (!confirmDelete) return;
    const identifier = confirmDelete.identifier;
    setConfirmDelete(null);
    try {
      const res = await fetch(`/api/todos/${encodeURIComponent(identifier)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setRows((prev) => prev.filter((r) => r.identifier !== identifier));
        setExpandedId((cur) => {
          // 削除した todo を選択中だったら選択解除
          const stillExists = (id: number | null) =>
            id !== null;
          return stillExists(cur) ? null : cur;
        });
        void reloadStats();
      }
    } catch (e) {
      console.warn("delete failed:", e);
    }
  }, [confirmDelete, reloadStats]);

  // 既存 caller との互換性のため deleteRow という名前は残し、確認 popup を挟む。
  const deleteRow = useCallback((identifier: string) => {
    askDelete(identifier);
  }, [askDelete]);

  const createTodo = useCallback(
    async (body: {
      title: string;
      project?: string;
      tags?: string[];
      priority?: 1 | 2 | 3;
      due_at?: string;
      note?: string;
    }) => {
      try {
        // intent dispatch 経由でも dedup は ON のまま。同タイトル active があれば
        // サーバが既存 row を返して duplicated_existing を載せてくる →
        // クライアントは新規作成と扱わず「既に登録されています」 notice を出す。
        const enrichedBody = {
          ...body,
          source: intentSource ?? undefined,
        };
        const res = await fetch("/api/todos", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(enrichedBody),
        });
        if (!res.ok) return false;
        const created = (await res.json()) as {
          todo?: { id?: number };
          duplicated_existing?: { id: number; identifier: string; title: string } | null;
        };
        const newId = created.todo?.id;
        // 既存ヒット (todo.id === duplicated_existing.id) なら新規ではない:
        //  - 「既に登録されています」notice を表示
        //  - 継承 project の auto-attach は既存 TODO に対しても走らせる (no-op になることが
        //    多いが、既存に project 紐付いてないケースだとここで足される)
        const isHitExisting =
          created.duplicated_existing != null &&
          newId === created.duplicated_existing.id;
        if (created.duplicated_existing) {
          setDupNotice({
            identifier: created.duplicated_existing.identifier,
            title: created.duplicated_existing.title,
          });
        }
        if (intentInheritedProjects.length > 0 && newId) {
          try {
            await Promise.all(
              intentInheritedProjects.map((p) =>
                fetch("/api/project-links", {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({
                    projectId: p.id,
                    artifactType: "todo",
                    artifactId: String(newId),
                    linkedBy: "intent",
                  }),
                })
              )
            );
          } catch (e) {
            console.warn("[todo] inherit attach failed:", e);
          }
        }
        void reloadAll();
        void reloadStats();
        // 既存ヒットだった場合は CreateForm を閉じて「重複でしたよ」UI に集約
        return !isHitExisting;
      } catch (e) {
        console.warn("create failed:", e);
        return false;
      }
    },
    [reloadStats, reloadAll, intentInheritedProjects, intentSource]
  );

  const { mounted, closing } = useModalTransition(open);
  if (!mounted) return null;

  return (
    <div
      className={`todo-modal-backdrop ${closing ? "modal-closing" : ""}`}
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className={`todo-modal ${closing ? "modal-closing" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="todo-modal-title"
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

        <header className="todo-modal-header">
          <h1 id="todo-modal-title">やることリスト</h1>
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
              name="todo-search"
              placeholder=""
              value={q}
              onChange={(e) => setQ(e.target.value)}
              className="todo-filter-input todo-filter-input-header"
              aria-label="検索"
            />
          </div>
          <div className="todo-modal-actions">
            <button
              type="button"
              className="todo-add-btn"
              onClick={() => setCreating((v) => !v)}
            >
              {creating ? "× キャンセル" : "＋ 新規"}
            </button>
          </div>
        </header>

        {dupNotice && (
          <div className="todo-dup-notice" role="status">
            <span>
              既に登録されています: <strong>{dupNotice.identifier}</strong>「{dupNotice.title}」
            </span>
            <button
              type="button"
              className="todo-dup-notice-close"
              onClick={() => setDupNotice(null)}
              aria-label="閉じる"
            >
              ×
            </button>
          </div>
        )}

        <div className="todo-modal-body">
          <div className="todo-list-pane">
            <div className="todo-filter">
              <div className="todo-project-header">
                <button
                  type="button"
                  className="todo-project-display"
                  onClick={() => setProjectPickerOpen((v) => !v)}
                  title="プロジェクト変更"
                >
                  {projectFilter === ""
                    ? "すべて"
                    : projectFilter === "__no_project__"
                      ? "プロジェクトなし"
                      : projectFilter}
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
                {projectPickerOpen && (
                  <ProjectPickerPopup
                    projects={projects}
                    current={projectFilter}
                    onPick={(v) => {
                      setProjectFilter(v);
                      setProjectPickerOpen(false);
                    }}
                    onClose={() => setProjectPickerOpen(false)}
                  />
                )}
                {stats && (stats.doneToday > 0 || stats.doneThisWeek > 0) && (
                  <div className="todo-done-stats" aria-label="完了サマリ">
                    {stats.doneToday > 0 && (
                      <span className="todo-done-stat">
                        今日 <strong>{stats.doneToday}</strong>
                      </span>
                    )}
                    {stats.doneThisWeek > 0 && (
                      <span className="todo-done-stat">
                        今週 <strong>{stats.doneThisWeek}</strong>
                      </span>
                    )}
                  </div>
                )}
              </div>
              <div className="todo-filter-row todo-filter-states">
                {STATES.map((s) => {
                  const c = stats?.byState[s];
                  return (
                    <label
                      key={s}
                      className={`todo-state-chip ${stateFilter.has(s) ? "active" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={stateFilter.has(s)}
                        onChange={() => toggleState(s)}
                      />
                      <StateIcon state={s} /> {STATE_LABEL[s]}
                      {typeof c === "number" && c > 0 && (
                        <span className="todo-state-chip-count">{c}</span>
                      )}
                    </label>
                  );
                })}
              </div>
            </div>

            <div className="todo-list">
              {creating && (
                <CreateForm
                  projects={projects}
                  defaultProject={
                    intentInheritedProjects[0]?.name ?? projectFilter
                  }
                  defaults={intentDraft ?? undefined}
                  inheritedProjects={intentInheritedProjects}
                  onCancel={() => setCreating(false)}
                  onCreate={async (b) => {
                    const ok = await createTodo(b);
                    if (ok) setCreating(false);
                  }}
                />
              )}

              {rows.length === 0 && !loading && !creating && (
                <div className="todo-empty">該当する TODO がありません。</div>
              )}

              {grouped.overdue.length > 0 && (
                <Section title={`期限超過 (${grouped.overdue.length})`}>
                  {grouped.overdue.map((r) => renderSummary(r))}
                </Section>
              )}
              {grouped.thisMonth.length > 0 && (
                <Section title={`今月末まで (${grouped.thisMonth.length})`}>
                  {grouped.thisMonth.map((r) => renderSummary(r))}
                </Section>
              )}
              {grouped.future.length > 0 && (
                <Section title={`来月以降 (${grouped.future.length})`}>
                  {grouped.future.map((r) => renderSummary(r))}
                </Section>
              )}
              {grouped.noDue.length > 0 && (
                <Section title={`期限なし (${grouped.noDue.length})`}>
                  {grouped.noDue.map((r) => renderSummary(r))}
                </Section>
              )}
              {grouped.done.length > 0 && (
                <Section title={`完了 (${grouped.done.length})`}>
                  {grouped.done.map((r) => renderSummary(r))}
                </Section>
              )}

              {loading && <div className="todo-loading">読み込み中…</div>}
            </div>
          </div>

          <div className="todo-detail-pane">
            {(() => {
              const selected = rows.find((r) => r.id === expandedId);
              if (!selected) {
                return (
                  <div className="todo-detail-empty">
                    左のリストから TODO を選択してください
                  </div>
                );
              }
              return (
                <TodoRowView
                  key={selected.id}
                  todo={selected}
                  expanded={true}
                  showDetail={true}
                  onToggle={() => setExpandedId(null)}
                  onPatch={(patch) => patchTodo(selected.identifier, patch)}
                  onDelete={() => deleteRow(selected.identifier)}
                  onProjectChipClick={(name) => setProjectFilter(name)}
                  onAskAddReminder={
                    sessionId ? () => setAddReminderTo(selected) : undefined
                  }
                />
              );
            })()}
          </div>
        </div>
        {/* end body */}

        {addReminderTo && sessionId && (
          <div
            className="reminder-popup-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setAddReminderTo(null);
            }}
          >
            <div className="reminder-popup" onClick={(e) => e.stopPropagation()}>
              <header className="reminder-popup-header">
                <h2>{addReminderTo.title} のリマインダー</h2>
              </header>
              <MiniReminderForm
                sessionId={sessionId}
                initial={{
                  kind: "todo_due",
                  title: addReminderTo.title,
                  refTable: "todos",
                  refId: addReminderTo.id,
                  scheduleKind: "once",
                  baseAt: addReminderTo.due_at ?? null,
                  leadMinutes: 0,
                }}
                lockKind="todo_due"
                lockScheduleKind="once"
                onCancel={() => setAddReminderTo(null)}
                onSaved={() => setAddReminderTo(null)}
              />
            </div>
          </div>
        )}

        {confirmDelete && (
          <div
            className="confirm-popup-backdrop"
            role="presentation"
            onClick={(e) => {
              if (e.target === e.currentTarget) setConfirmDelete(null);
            }}
          >
            <div className="confirm-popup" role="dialog" aria-modal="true" aria-labelledby="confirm-popup-title">
              <h2 id="confirm-popup-title" className="confirm-popup-title">削除の確認</h2>
              <p className="confirm-popup-body">
                <strong className="confirm-popup-target">「{confirmDelete.title}」</strong>
                を削除しますか?
                <br />
                <span className="confirm-popup-note">この操作は取り消せません。</span>
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

  function renderSummary(r: TodoRow) {
    return (
      <TodoRowView
        key={r.id}
        todo={r}
        expanded={expandedId === r.id}
        showDetail={false}
        onToggle={() => setExpandedId(r.id)}
        onPatch={(patch) => patchTodo(r.identifier, patch)}
        onDelete={() => deleteRow(r.identifier)}
      />
    );
  }
}

/**
 * プロジェクト切替ミニ popup。左ペインのプロジェクト名表示クリックで開く。
 * 「すべて」「プロジェクトなし」と全プロジェクトを縦リスト表示。
 */
function ProjectPickerPopup({
  projects,
  current,
  onPick,
  onClose,
}: {
  projects: ProjectInfo[];
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
  const items: { label: string; value: string }[] = [
    { label: "すべて", value: "" },
    { label: "プロジェクトなし", value: "__no_project__" },
    ...projects.map((p) => ({ label: p.name, value: p.name })),
  ];
  return (
    <div className="todo-project-popup" ref={ref} role="dialog">
      <ul className="todo-project-popup-list">
        {items.map((it) => (
          <li key={it.value}>
            <button
              type="button"
              className={`todo-project-popup-item ${current === it.value ? "active" : ""}`}
              onClick={() => onPick(it.value)}
            >
              {it.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="todo-section">
      <h2 className="todo-section-title">{title}</h2>
      <div className="todo-rows">{children}</div>
    </section>
  );
}

function TodoRowView({
  todo,
  expanded,
  showDetail = expanded,
  onToggle,
  onPatch,
  onDelete,
  onProjectChipClick,
  onAskAddReminder,
}: {
  todo: TodoRow;
  /** 視覚的にハイライトするか (選択中の行) */
  expanded: boolean;
  /** 行下に編集 form を inline 表示するか (右ペインで使う時のみ true) */
  showDetail?: boolean;
  onToggle: () => void;
  onPatch: (patch: Partial<TodoRow> & { project?: string | null }) => void;
  onDelete: () => void;
  /** 詳細ペインの chip 本体クリック → 左リストを project でフィルタ */
  onProjectChipClick?: (projectName: string) => void;
  /** 「+ リマインダー」ボタン押下時 (詳細パネル foot に表示) */
  onAskAddReminder?: () => void;
}) {
  // ローカル編集 state (debounce 保存)
  const [title, setTitle] = useState(todo.title);
  const [note, setNote] = useState(todo.note ?? "");
  const [url, setUrl] = useState(todo.url ?? "");
  // タイトル / 日付のインライン編集トグル (showDetail=true でのみ有効)。
  // project はインライン編集を廃止し、ProjectChipsEditor (詳細パネル) に一本化済。
  const [editingTitle, setEditingTitle] = useState(false);
  const [editingStart, setEditingStart] = useState(false);
  const [editingDue, setEditingDue] = useState(false);
  // 「+ タグ追加」を押した時にだけ input を出す (summary 行で完結させるため)
  const [addingTag, setAddingTag] = useState(false);

  // state 変更時のヘルパ: backlog/blocked → in_progress に上がる時、
  // startAt 未設定なら今日に自動でセットする。
  const onChangeState = (next: TodoState) => {
    const patch: Partial<TodoRow> & { project?: string | null } = { state: next };
    if (next === "in_progress" && !todo.start_at) {
      patch.start_at = new Date().toISOString();
    }
    onPatch(patch);
  };
  const [dueAt, setDueAt] = useState(toDateInputValue(todo.due_at));
  const [startAt, setStartAt] = useState(toDateInputValue(todo.start_at));
  const [tagInput, setTagInput] = useState("");

  // todo が外部から更新された時、ローカル state を同期 (anti-pattern #4 / key prop follow-up)。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setTitle(todo.title);
    setNote(todo.note ?? "");
    setUrl(todo.url ?? "");
    setDueAt(toDateInputValue(todo.due_at));
    setStartAt(toDateInputValue(todo.start_at));
  }, [todo.id, todo.title, todo.note, todo.url, todo.due_at, todo.start_at]);
  /* eslint-enable react-hooks/set-state-in-effect */

  // debounce 保存ヘルパ
  const debounceSave = (
    fn: () => void,
    ref: React.MutableRefObject<ReturnType<typeof setTimeout> | null>,
    delay = 600
  ) => {
    if (ref.current) clearTimeout(ref.current);
    ref.current = setTimeout(fn, delay);
  };
  const titleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const noteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const urlTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dueTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const startTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const onChangeTitle = (v: string) => {
    setTitle(v);
    debounceSave(() => onPatch({ title: v.trim() }), titleTimer);
  };
  const onChangeNote = (v: string) => {
    setNote(v);
    debounceSave(() => onPatch({ note: v }), noteTimer);
  };
  const onChangeUrl = (v: string) => {
    setUrl(v);
    debounceSave(() => onPatch({ url: v }), urlTimer);
  };
  const onChangeDue = (v: string) => {
    setDueAt(v);
    debounceSave(() => onPatch({ due_at: v ? dateInputToIso(v) : null }), dueTimer);
  };
  const onChangeStart = (v: string) => {
    setStartAt(v);
    debounceSave(() => onPatch({ start_at: v ? dateInputToIso(v) : null }), startTimer);
  };

  const addTag = () => {
    const v = tagInput.trim();
    if (!v) return;
    if (todo.tags.includes(v)) return;
    const next = [...todo.tags, v];
    onPatch({ tags: next });
    setTagInput("");
  };
  const removeTag = (t: string) => {
    onPatch({ tags: todo.tags.filter((x) => x !== t) });
  };

  // リスト用 (showDetail=false) の簡略 main: badges 1 行目 + [チェックボックス][タイトル] 2-3 行目。
  // タイトルは 2 行を超えたら ... で省略。
  if (!showDetail) {
    return (
      <div
        className={`todo-row ${expanded ? "expanded" : ""}`}
        onClick={onToggle}
      >
        <div className="todo-row-main todo-row-main-list">
          <button
            type="button"
            className={`todo-state-btn todo-state-${todo.state}`}
            onClick={(e) => {
              e.stopPropagation();
              const nextState: Record<TodoState, TodoState> = {
                backlog: "in_progress",
                in_progress: "done",
                done: "backlog",
                blocked: "in_progress",
              };
              onChangeState(nextState[todo.state]);
            }}
            title={`${STATE_LABEL[todo.state]} (クリックで次の状態)`}
          >
            <StateIcon state={todo.state} size={14} />
          </button>
          <div className="todo-row-badges-line">
            <span className="todo-due">{fmtDate(todo.due_at)}</span>
            <button
              type="button"
              className="todo-pri-btn"
              onClick={(e) => {
                e.stopPropagation();
                const next = (todo.priority % 3) + 1;
                onPatch({ priority: next as 1 | 2 | 3 });
              }}
              title={`優先度 ${PRIORITY_LABEL[todo.priority]} (クリックで変更)`}
            >
              <PriorityIcon priority={todo.priority} size={13} />
            </button>
            {todo.tags.length > 0 && (
              <span className="todo-tags">
                {todo.tags.map((t) => (
                  <span key={t} className="todo-tag">
                    {t}
                  </span>
                ))}
              </span>
            )}
            {todo.linked_projects.length > 0 && (
              <ProjectChips
                chips={todo.linked_projects.map((p) => ({
                  id: p.id,
                  name: p.name,
                  color: p.color,
                  linkedBy: p.linked_by as "manual" | "ai" | "intent" | "primary",
                }))}
              />
            )}
          </div>
          <span
            className={`todo-title-multiline ${todo.state === "done" ? "done" : ""}`}
          >
            {todo.title}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className={`todo-row ${expanded ? "expanded" : ""}`}>
      <div
        className="todo-row-main"
        onClick={undefined}
      >
        <button
          type="button"
          className={`todo-state-btn todo-state-${todo.state}`}
          onClick={(e) => {
            e.stopPropagation();
            // クリックで state 順送り: backlog → in_progress → done → backlog
            const next: Record<TodoState, TodoState> = {
              backlog: "in_progress",
              in_progress: "done",
              done: "backlog",
              blocked: "in_progress",
            };
            onChangeState(next[todo.state]);
          }}
          title={`${STATE_LABEL[todo.state]} (クリックで次の状態)`}
        >
          <StateIcon state={todo.state} size={13} />
        </button>
        <button
          type="button"
          className="todo-pri-btn"
          onClick={(e) => {
            e.stopPropagation();
            const next = (todo.priority % 3) + 1;
            onPatch({ priority: next as 1 | 2 | 3 });
          }}
          title={`優先度 ${PRIORITY_LABEL[todo.priority]} (クリックで変更)`}
        >
          <PriorityIcon priority={todo.priority} size={13} />
        </button>
        <span className="todo-id">{todo.identifier}</span>
        {showDetail && editingTitle ? (
          <input
            name="todo-title"
            className={`todo-title todo-title-edit ${todo.state === "done" ? "done" : ""}`}
            value={title}
            autoFocus
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onChangeTitle(e.target.value)}
            onBlur={() => setEditingTitle(false)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                setEditingTitle(false);
              } else if (e.key === "Escape") {
                setEditingTitle(false);
              }
            }}
          />
        ) : (
          <span
            className={`todo-title ${todo.state === "done" ? "done" : ""}`}
            onClick={(e) => {
              if (showDetail) {
                e.stopPropagation();
                setEditingTitle(true);
              }
            }}
            title={showDetail ? "クリックで編集" : undefined}
          >
            {todo.title}
          </span>
        )}
        {!showDetail && (
          <span className="todo-due">{fmtDate(todo.due_at)}</span>
        )}
        {/* 詳細ペインヘッダ: chip 表示 + 「+」追加 + × 削除を一箇所に集約。
            リスト card 側は !showDetail 分岐で読取専用 ProjectChips。 */}
        <ProjectChipsEditor
          artifactType="todo"
          artifactId={String(todo.id)}
          artifactPayload={{
            type: "todo",
            data: {
              title: todo.title,
              note: todo.note ?? undefined,
              dueAt: todo.due_at ?? undefined,
              tags: todo.tags,
            },
          }}
          // chip 本体クリック → 左リストをそのプロジェクトでフィルタ。× ボタンは
          // ProjectChips 側で stopPropagation 済なので独立に動作 (= 解除のみ)。
          onChipClick={onProjectChipClick ? (chip) => onProjectChipClick(chip.name) : undefined}
        />
        {showDetail ? (
          <span className="todo-tags todo-tags-edit">
            {todo.tags.map((t) => (
              <span key={t} className="todo-tag todo-tag-chip">
                {t}
                <button
                  type="button"
                  className="todo-tag-chip-x"
                  onClick={(e) => {
                    e.stopPropagation();
                    removeTag(t);
                  }}
                  aria-label={`${t} を削除`}
                  title="削除"
                >
                  ×
                </button>
              </span>
            ))}
            {addingTag ? (
              <input
                name="todo-tag-add"
                className="todo-tag-add-input"
                value={tagInput}
                autoFocus
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => setTagInput(e.target.value)}
                onBlur={() => {
                  addTag();
                  setAddingTag(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    addTag();
                  } else if (e.key === "Escape") {
                    setTagInput("");
                    setAddingTag(false);
                  }
                }}
                placeholder="タグ名"
              />
            ) : (
              <button
                type="button"
                className="todo-tag-add-btn"
                onClick={(e) => {
                  e.stopPropagation();
                  setAddingTag(true);
                }}
              >
                + タグ追加
              </button>
            )}
          </span>
        ) : (
          todo.tags.length > 0 && (
            <span className="todo-tags">
              {todo.tags.map((t) => (
                <span key={t} className="todo-tag">
                  {t}
                </span>
              ))}
            </span>
          )
        )}
      </div>

      {showDetail && (
        <div className="todo-row-detail">
          <div className="todo-edit-grid">
            <label className="todo-edit-label">
              <span>状態</span>
              <div className="todo-state-chips">
                {STATES.map((s) => (
                  <button
                    key={s}
                    type="button"
                    className={`todo-state-chip-mini ${todo.state === s ? "active" : ""} todo-state-${s}`}
                    onClick={() => onChangeState(s)}
                  >
                    <StateIcon state={s} /> {STATE_LABEL[s]}
                  </button>
                ))}
              </div>
            </label>

            <label className="todo-edit-label">
              <span>優先度</span>
              <div className="todo-state-chips">
                {[1, 2, 3].map((p) => (
                  <button
                    key={p}
                    type="button"
                    className={`todo-state-chip-mini ${todo.priority === p ? "active" : ""}`}
                    onClick={() => onPatch({ priority: p as 1 | 2 | 3 })}
                  >
                    <PriorityIcon priority={p as 1 | 2 | 3} /> {PRIORITY_LABEL[p]}
                  </button>
                ))}
              </div>
            </label>

            <div className="todo-date-range todo-edit-label-wide">
              <div className="todo-date-anchor">
                <button
                  type="button"
                  className="todo-date-pill"
                  onClick={() => {
                    setEditingDue(false);
                    setEditingStart((v) => !v);
                  }}
                  title="開始日 (クリックで編集)"
                >
                  <span className="todo-date-label">開始</span>
                  <span className="todo-date-value">{fmtDateJa(startAt)}</span>
                </button>
                {editingStart && (
                  <MiniCalendar
                    value={startAt}
                    onChange={(v) => {
                      onChangeStart(v);
                      setEditingStart(false);
                    }}
                    onClose={() => setEditingStart(false)}
                  />
                )}
              </div>
              <span className="todo-date-arrow" aria-hidden="true">→</span>
              <div className="todo-date-anchor">
                <button
                  type="button"
                  className="todo-date-pill"
                  onClick={() => {
                    setEditingStart(false);
                    setEditingDue((v) => !v);
                  }}
                  title="期限 (クリックで編集)"
                >
                  <span className="todo-date-label">期限</span>
                  <span className="todo-date-value">{fmtDateJa(dueAt)}</span>
                </button>
                {editingDue && (
                  <MiniCalendar
                    value={dueAt}
                    onChange={(v) => {
                      onChangeDue(v);
                      setEditingDue(false);
                    }}
                    onClose={() => setEditingDue(false)}
                  />
                )}
              </div>
            </div>

          </div>

          <label className="todo-edit-label todo-edit-label-wide todo-edit-memo-block">
            <textarea
              name="todo-note"
              value={note}
              onChange={(e) => onChangeNote(e.target.value)}
              rows={3}
              placeholder="メモ"
            />
          </label>

          <label className="todo-edit-label todo-edit-label-wide todo-edit-url-block">
            <span>URL</span>
            <input name="todo-url" value={url} onChange={(e) => onChangeUrl(e.target.value)} />
          </label>

          <div className="todo-detail-actions">
            <IntentKebabMenu
              sourceRefId={String(todo.id)}
              sourcePayload={{
                type: "todo",
                data: {
                  title: todo.title,
                  note: todo.note ?? undefined,
                  dueAt: todo.due_at ?? undefined,
                  tags: todo.tags,
                },
              }}
              targets={["event"]}
            />
          </div>

          <ArtifactLinksPanel artifactType="todo" artifactId={String(todo.id)} />

          <div className="todo-detail-foot">
            <div className="todo-meta">
              {todo.external_ref && <span>外部参照: {todo.external_ref}</span>}
              <span>登録: {fmtDate(todo.created_at)}</span>
              {todo.completed_at && <span>完了: {fmtDate(todo.completed_at)}</span>}
            </div>
            <div className="todo-detail-foot-actions">
              {onAskAddReminder && (
                <button
                  type="button"
                  className="todo-add-reminder-btn"
                  onClick={onAskAddReminder}
                  title="リマインダーを追加"
                >
                  + リマインダー
                </button>
              )}
              <button type="button" className="todo-delete-btn" onClick={onDelete}>
                削除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function CreateForm({
  projects,
  defaultProject,
  defaults,
  inheritedProjects,
  onCancel,
  onCreate,
}: {
  projects: ProjectInfo[];
  defaultProject?: string;
  /** Intent dispatch 経由で渡される pre-fill 値。null 安全。 */
  defaults?: {
    title?: string;
    note?: string;
    dueIso?: string;
    tags?: string[];
  };
  /** Intent dispatch 経由で source から継承する project リスト。
   *  1 つ目を primary (defaultProject 経由で project 欄に流す)、残りは保存後に
   *  TodoModal 側 createTodo フックが M:N attach する想定。
   *  UI 上は chip プレビュー表示でご主人様に「ここに紐付きます」を見せる。 */
  inheritedProjects?: Array<{ id: number; name: string; color: string | null }>;
  onCancel: () => void;
  onCreate: (body: {
    title: string;
    project?: string;
    tags?: string[];
    priority?: 1 | 2 | 3;
    due_at?: string;
    note?: string;
  }) => Promise<void>;
}) {
  const [title, setTitle] = useState(defaults?.title ?? "");
  const [project, setProject] = useState(defaultProject ?? "");
  const [tagsInput, setTagsInput] = useState(defaults?.tags?.join(", ") ?? "");
  const [priority, setPriority] = useState<1 | 2 | 3>(2);
  const [due, setDue] = useState(defaults?.dueIso ? defaults.dueIso.slice(0, 10) : "");
  const [note, setNote] = useState(defaults?.note ?? "");
  const [submitting, setSubmitting] = useState(false);

  const submit = async () => {
    if (!title.trim()) return;
    setSubmitting(true);
    try {
      await onCreate({
        title: title.trim(),
        project: project.trim() || undefined,
        tags: tagsInput
          .split(/[,、\s]+/)
          .map((s) => s.trim())
          .filter(Boolean),
        priority,
        due_at: due ? dateInputToIso(due) ?? undefined : undefined,
        note: note.trim() || undefined,
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="todo-create">
      <h3>新規 TODO</h3>
      {inheritedProjects && inheritedProjects.length > 0 && (
        <div className="todo-create-inherit">
          <span className="todo-create-inherit-label">継承プロジェクト:</span>
          <ProjectChips
            chips={inheritedProjects.map((p) => ({
              id: p.id,
              name: p.name,
              color: p.color,
              linkedBy: "intent",
            }))}
          />
        </div>
      )}
      <div className="todo-edit-grid">
        <label className="todo-edit-label todo-edit-label-wide">
          <span>タイトル</span>
          <input
            name="new-todo-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="必須"
            autoFocus
          />
        </label>
        <label className="todo-edit-label">
          <span>プロジェクト</span>
          <input
            name="new-todo-project"
            list="projects-create"
            value={project}
            onChange={(e) => setProject(e.target.value)}
            placeholder="(Inbox)"
          />
          <datalist id="projects-create">
            {projects.map((p) => (
              <option key={p.id} value={p.name} />
            ))}
          </datalist>
        </label>
        <label className="todo-edit-label">
          <span>期限</span>
          <input name="new-todo-due" type="date" value={due} onChange={(e) => setDue(e.target.value)} />
        </label>
        <label className="todo-edit-label">
          <span>優先度</span>
          <div className="todo-state-chips">
            {[1, 2, 3].map((p) => (
              <button
                key={p}
                type="button"
                className={`todo-state-chip-mini ${priority === p ? "active" : ""}`}
                onClick={() => setPriority(p as 1 | 2 | 3)}
              >
                <PriorityIcon priority={p as 1 | 2 | 3} /> {PRIORITY_LABEL[p]}
              </button>
            ))}
          </div>
        </label>
        <label className="todo-edit-label todo-edit-label-wide">
          <span>タグ (カンマ区切り)</span>
          <input
            name="new-todo-tags"
            value={tagsInput}
            onChange={(e) => setTagsInput(e.target.value)}
            placeholder="例: 本, 緊急"
          />
        </label>
        <label className="todo-edit-label todo-edit-label-wide">
          <span>メモ</span>
          <textarea name="new-todo-note" value={note} onChange={(e) => setNote(e.target.value)} rows={3} />
        </label>
      </div>
      <div className="todo-detail-foot">
        <button type="button" onClick={onCancel} className="todo-cancel-btn">
          キャンセル
        </button>
        <button type="button" onClick={submit} disabled={!title.trim() || submitting} className="todo-save-btn">
          {submitting ? "作成中…" : "作成"}
        </button>
      </div>
    </div>
  );
}
