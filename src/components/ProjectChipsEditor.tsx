"use client";

/**
 * Project Chips Editor — 各ツール (連絡先 / メール / 予定 / TODO) の
 * detail に挿入する共通 component。
 *
 * 使い方:
 *   <ProjectChipsEditor
 *     artifactType="contact"
 *     artifactId="123"
 *     artifactPayload={{ type: "contact", data: { ... } }}  // 任意、AI 提案に使う
 *   />
 *
 * 機能:
 *   - 現在紐付いてる project を chip 列挙 (色付き)
 *   - 「+」ボタン → popover で AI 提案 (Yui の提案) + 全プロジェクト一覧
 *   - chip の × で detach (primary は読み取り専用、× 出さない)
 *   - 永続化は /api/project-links 経由
 *
 * 設計: docs/roadmap.md §6.8 (project-links Phase 2)
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactPayload } from "@/lib/artifact-payloads";
import ProjectChips, { type Chip } from "./ProjectChips";

type LinkedProject = {
  id: number;
  name: string;
  color: string | null;
  linkedBy: "manual" | "ai" | "intent" | "primary";
};

type AllProject = {
  id: number;
  name: string;
  color: string | null;
  archived: boolean;
};

type Suggestion = {
  projectId: number;
  confidence: number;
  reason: string;
};

type Props = {
  artifactType: "todo" | "mail" | "event" | "contact" | "memo";
  artifactId: string;
  /** AI 提案用 (省略可、省略時は popover に「全プロジェクト」のみ表示) */
  artifactPayload?: ArtifactPayload;
  /** 外部から差替を通知したい時インクリメント */
  reloadKey?: number;
  /** chip 列の左に出す小さいラベル ("プロジェクト" 等)。省略可 */
  label?: string;
  /** chip 本体クリック時のハンドラ (例: TodoModal でリストを project でフィルタする)。
   *  指定すると chip 本体がボタン化される。× ボタンは stopPropagation 済なので独立に動作。 */
  onChipClick?: (chip: Chip) => void;
};

export default function ProjectChipsEditor({
  artifactType,
  artifactId,
  artifactPayload,
  reloadKey,
  label,
  onChipClick,
}: Props) {
  const [linked, setLinked] = useState<LinkedProject[]>([]);
  const [allProjects, setAllProjects] = useState<AllProject[]>([]);
  const [popoverOpen, setPopoverOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [suggestLoading, setSuggestLoading] = useState(false);
  const [suggestWarning, setSuggestWarning] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const plusBtnRef = useRef<HTMLButtonElement | null>(null);

  const reloadLinked = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/project-links?artifactType=${encodeURIComponent(
          artifactType
        )}&artifactId=${encodeURIComponent(artifactId)}`,
        { cache: "no-store" }
      );
      if (!res.ok) return;
      const json = (await res.json()) as { projects: LinkedProject[] };
      setLinked(json.projects);
    } catch (e) {
      console.warn("[project-chips] reloadLinked failed:", e);
    }
  }, [artifactType, artifactId]);

  const reloadAllProjects = useCallback(async () => {
    try {
      const res = await fetch("/api/projects", { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { projects: AllProject[] };
      setAllProjects(json.projects.filter((p) => !p.archived));
    } catch (e) {
      console.warn("[project-chips] reloadAllProjects failed:", e);
    }
  }, []);

  useEffect(() => {
    // reloadKey 変更 (= 親が「再 fetch して」と通知) で紐付き一覧再取得。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-change fetch
    void reloadLinked();
  }, [reloadLinked, reloadKey]);

  // popover を開いた時に全プロジェクト + AI 提案を取りに行く
  const openPopover = async () => {
    setPopoverOpen(true);
    setSearch("");
    setSuggestWarning(null);
    if (allProjects.length === 0) await reloadAllProjects();
    if (artifactPayload) {
      setSuggestLoading(true);
      setSuggestions([]);
      try {
        const res = await fetch("/api/project-links/suggest", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(artifactPayload),
        });
        if (res.ok) {
          const json = (await res.json()) as {
            suggestions: Suggestion[];
            warning?: string;
          };
          setSuggestions(json.suggestions);
          if (json.warning) setSuggestWarning(json.warning);
        }
      } catch (e) {
        console.warn("[project-chips] suggest failed:", e);
      } finally {
        setSuggestLoading(false);
      }
    }
  };

  // popover を閉じる: 外クリック / Escape
  useEffect(() => {
    if (!popoverOpen) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popoverRef.current?.contains(t)) return;
      if (plusBtnRef.current?.contains(t)) return;
      setPopoverOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPopoverOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [popoverOpen]);

  const linkedIdSet = useMemo(() => new Set(linked.map((p) => p.id)), [linked]);

  const attach = async (projectId: number, linkedBy: "manual" | "ai" = "manual") => {
    try {
      const res = await fetch("/api/project-links", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId,
          artifactType,
          artifactId,
          linkedBy,
        }),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { projects: LinkedProject[] };
      setLinked(json.projects);
    } catch (e) {
      console.warn("[project-chips] attach failed:", e);
    }
  };

  const detach = async (projectId: number) => {
    try {
      const params = new URLSearchParams({
        projectId: String(projectId),
        artifactType,
        artifactId,
      });
      const res = await fetch(`/api/project-links?${params.toString()}`, {
        method: "DELETE",
      });
      if (!res.ok) return;
      setLinked((prev) => prev.filter((p) => p.id !== projectId));
    } catch (e) {
      console.warn("[project-chips] detach failed:", e);
    }
  };

  const filteredAll = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allProjects
      .filter((p) => !q || p.name.toLowerCase().includes(q))
      .filter((p) => !linkedIdSet.has(p.id));
  }, [allProjects, search, linkedIdSet]);

  const suggestionEntries = useMemo(() => {
    return suggestions
      .filter((s) => !linkedIdSet.has(s.projectId))
      .map((s) => {
        const p = allProjects.find((q) => q.id === s.projectId);
        return p ? { ...s, project: p } : null;
      })
      .filter((x): x is { project: AllProject } & Suggestion => x !== null)
      .sort((a, b) => b.confidence - a.confidence);
  }, [suggestions, linkedIdSet, allProjects]);

  const chips: Chip[] = linked.map((p) => ({
    id: p.id,
    name: p.name,
    color: p.color,
    linkedBy: p.linkedBy,
  }));

  return (
    <div className="project-chips-editor">
      {label && <span className="project-chips-label">{label}</span>}
      <ProjectChips
        chips={chips}
        onChipClick={onChipClick}
        onRemove={(chip) => void detach(chip.id)}
        trailing={
          <span className="project-chips-add">
            <button
              ref={plusBtnRef}
              type="button"
              className="project-chips-plus"
              onClick={() => (popoverOpen ? setPopoverOpen(false) : void openPopover())}
              aria-label="プロジェクトを追加"
              title="プロジェクトを追加"
            >
              +
            </button>
            {popoverOpen && (
          <div ref={popoverRef} className="project-chips-popover" role="dialog">
            {artifactPayload && (
              <div className="project-chips-section">
                <div className="project-chips-section-head">Yui の提案</div>
                {suggestLoading && (
                  <div className="project-chips-empty">考え中…</div>
                )}
                {!suggestLoading &&
                  suggestionEntries.length === 0 &&
                  !suggestWarning && (
                    <div className="project-chips-empty">候補なし</div>
                  )}
                {!suggestLoading && suggestWarning && (
                  <div className="project-chips-empty">
                    AI 失敗: {suggestWarning}
                  </div>
                )}
                {suggestionEntries.map((s) => (
                  <button
                    key={s.projectId}
                    type="button"
                    className="project-chips-row"
                    onClick={() => {
                      void attach(s.projectId, "ai");
                      setPopoverOpen(false);
                    }}
                  >
                    {s.project.color && (
                      <span
                        className="project-chip-dot"
                        style={{ background: s.project.color }}
                      />
                    )}
                    <span className="project-chips-row-name">{s.project.name}</span>
                    <span className="project-chips-row-conf">
                      {Math.round(s.confidence * 100)}%
                    </span>
                  </button>
                ))}
              </div>
            )}
            <div className="project-chips-section">
              <div className="project-chips-section-head">全プロジェクト</div>
              <input
                name="project-chips-search"
                type="text"
                value={search}
                placeholder="検索…"
                onChange={(e) => setSearch(e.target.value)}
                className="project-chips-search"
                autoFocus
              />
              <div className="project-chips-list">
                {filteredAll.length === 0 ? (
                  <div className="project-chips-empty">
                    {search ? "該当なし" : "全部紐付け済"}
                  </div>
                ) : (
                  filteredAll.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className="project-chips-row"
                      onClick={() => {
                        void attach(p.id, "manual");
                        setPopoverOpen(false);
                      }}
                    >
                      {p.color && (
                        <span
                          className="project-chip-dot"
                          style={{ background: p.color }}
                        />
                      )}
                      <span className="project-chips-row-name">{p.name}</span>
                    </button>
                  ))
                )}
              </div>
            </div>
          </div>
        )}
          </span>
        }
      />
    </div>
  );
}
