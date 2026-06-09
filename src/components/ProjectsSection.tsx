"use client";

/**
 * プロジェクト管理 (SettingsModal の「プロジェクト」タブ)。
 * 追加 / 名前編集 / 色設定 / アーカイブ / 完全削除に対応。
 */
import { useCallback, useEffect, useState } from "react";

type Project = {
  id: number;
  name: string;
  color: string | null;
  description: string | null;
  archived: boolean;
  todo_count: number;
  active_count: number;
};

/** 8 色 preset (世界観: パステル + ジュエル系)。+ カスタム HEX で自由色も。 */
const COLOR_PRESETS: Array<{ name: string; hex: string }> = [
  { name: "桜", hex: "#f9a8d4" },
  { name: "藤", hex: "#c084fc" },
  { name: "空", hex: "#7dd3fc" },
  { name: "若葉", hex: "#86efac" },
  { name: "山吹", hex: "#fde047" },
  { name: "夕焼け", hex: "#fda4af" },
  { name: "灰桜", hex: "#94a3b8" },
  { name: "桔梗", hex: "#818cf8" },
];

export default function ProjectsSection() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<{ id: number; name: string } | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/projects?include_archived=1&with_counts=1");
      if (!res.ok) return;
      const data = (await res.json()) as { projects: Project[] };
      setProjects(data.projects ?? []);
    } catch (e) {
      console.warn("[projects] reload failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回 mount + reload 変化時に projects を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();
  }, [reload]);

  const patch = async (id: number, body: Record<string, unknown>) => {
    try {
      const res = await fetch(`/api/projects/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) await reload();
    } catch (e) {
      console.warn("[projects] patch failed:", e);
    }
  };

  const createProject = async () => {
    const name = newName.trim();
    if (!name) return;
    try {
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (res.ok) {
        setNewName("");
        setCreating(false);
        await reload();
      }
    } catch (e) {
      console.warn("[projects] create failed:", e);
    }
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    setConfirmDelete(null);
    try {
      const res = await fetch(`/api/projects/${id}`, { method: "DELETE" });
      if (res.ok) await reload();
    } catch (e) {
      console.warn("[projects] delete failed:", e);
    }
  };

  const active = projects.filter((p) => !p.archived);
  const archived = projects.filter((p) => p.archived);

  return (
    <div className="projects-section">
      <div className="projects-toolbar">
        {creating ? (
          <div className="projects-new-form">
            <input
              name="project-new-name"
              type="text"
              value={newName}
              autoFocus
              placeholder="プロジェクト名"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  void createProject();
                } else if (e.key === "Escape") {
                  setCreating(false);
                  setNewName("");
                }
              }}
              className="projects-new-input"
            />
            <button
              type="button"
              className="todo-add-btn"
              onClick={() => void createProject()}
              disabled={!newName.trim()}
            >
              追加
            </button>
            <button
              type="button"
              className="confirm-cancel-btn"
              onClick={() => {
                setCreating(false);
                setNewName("");
              }}
            >
              キャンセル
            </button>
          </div>
        ) : (
          <button
            type="button"
            className="todo-add-btn"
            onClick={() => setCreating(true)}
          >
            ＋ 新規プロジェクト
          </button>
        )}
      </div>

      {loading && projects.length === 0 && (
        <div className="settings-placeholder">読み込み中…</div>
      )}

      {active.length > 0 && (
        <ul className="projects-list">
          {active.map((p) => (
            <ProjectCard
              key={p.id}
              project={p}
              expanded={expandedId === p.id}
              onToggle={() =>
                setExpandedId((cur) => (cur === p.id ? null : p.id))
              }
              onPatch={(body) => patch(p.id, body)}
              onAskDelete={() => setConfirmDelete({ id: p.id, name: p.name })}
            />
          ))}
        </ul>
      )}

      {archived.length > 0 && (
        <>
          <h3 className="projects-section-title">アーカイブ済み ({archived.length})</h3>
          <ul className="projects-list projects-list-archived">
            {archived.map((p) => (
              <ProjectCard
                key={p.id}
                project={p}
                expanded={expandedId === p.id}
                onToggle={() =>
                  setExpandedId((cur) => (cur === p.id ? null : p.id))
                }
                onPatch={(body) => patch(p.id, body)}
                onAskDelete={() => setConfirmDelete({ id: p.id, name: p.name })}
              />
            ))}
          </ul>
        </>
      )}

      {!loading && projects.length === 0 && (
        <div className="settings-placeholder">
          プロジェクトはまだありません。「+ 新規プロジェクト」から追加してください。
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
          <div className="confirm-popup" role="dialog" aria-modal="true">
            <h2 className="confirm-popup-title">プロジェクト削除の確認</h2>
            <p className="confirm-popup-body">
              <strong className="confirm-popup-target">「{confirmDelete.name}」</strong>
              を完全に削除しますか?
              <br />
              <span className="confirm-popup-note">
                このプロジェクトに紐づく todo は Inbox (未所属) に流されます。
                操作は取り消せません。
              </span>
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
  );
}

function ProjectCard({
  project,
  expanded,
  onToggle,
  onPatch,
  onAskDelete,
}: {
  project: Project;
  expanded: boolean;
  onToggle: () => void;
  onPatch: (body: Record<string, unknown>) => Promise<void>;
  onAskDelete: () => void;
}) {
  const [name, setName] = useState(project.name);
  const [description, setDescription] = useState(project.description ?? "");
  const [customHex, setCustomHex] = useState(project.color ?? "#c084fc");

  // project prop 変化時に編集中の値を同期。anti-pattern #4 (key prop) follow-up。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setName(project.name);
    setDescription(project.description ?? "");
    if (project.color) setCustomHex(project.color);
  }, [project.id, project.name, project.description, project.color]);
  /* eslint-enable react-hooks/set-state-in-effect */

  const swatchColor = project.color ?? "rgba(45,34,56,0.18)";

  return (
    <li className={`project-card ${expanded ? "expanded" : ""} ${project.archived ? "archived" : ""}`}>
      <div
        className="project-card-head"
        onClick={onToggle}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <span
          className="project-card-swatch"
          style={{ background: swatchColor }}
          aria-hidden="true"
        />
        <span className="project-card-name">{project.name}</span>
        <span className="project-card-count">
          {project.active_count} / {project.todo_count}
        </span>
        {project.archived && <span className="project-card-archived">アーカイブ</span>}
        <span className={`project-card-chevron ${expanded ? "open" : ""}`} aria-hidden="true">
          ›
        </span>
      </div>

      {expanded && (
        <div className="project-card-body">
          <label className="project-edit-label">
            <span>名前</span>
            <input
              name="project-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (name.trim() && name !== project.name) {
                  void onPatch({ name: name.trim() });
                }
              }}
            />
          </label>

          <div className="project-edit-label">
            <span>色</span>
            <div className="project-color-row">
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c.hex}
                  type="button"
                  className={`project-color-swatch ${project.color?.toLowerCase() === c.hex.toLowerCase() ? "active" : ""}`}
                  style={{ background: c.hex }}
                  onClick={() => void onPatch({ color: c.hex })}
                  title={c.name}
                  aria-label={c.name}
                />
              ))}
              <label
                className="project-color-custom"
                title="カスタム色を選ぶ"
              >
                <input
                  name="project-color"
                  type="color"
                  value={customHex}
                  onChange={(e) => {
                    setCustomHex(e.target.value);
                  }}
                  onBlur={() => {
                    if (customHex !== project.color) {
                      void onPatch({ color: customHex });
                    }
                  }}
                />
                <span style={{ background: customHex }} />
              </label>
              <button
                type="button"
                className="project-color-clear"
                onClick={() => void onPatch({ color: null })}
                title="色をクリア"
              >
                ×
              </button>
            </div>
          </div>

          <label className="project-edit-label">
            <span>説明 (任意)</span>
            <textarea
              name="project-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              onBlur={() => {
                if (description !== (project.description ?? "")) {
                  void onPatch({ description: description.trim() || null });
                }
              }}
              rows={2}
              placeholder="このプロジェクトの目的や進め方をメモ"
            />
          </label>

          <div className="project-card-actions">
            <button
              type="button"
              className="settings-btn"
              onClick={() => void onPatch({ archived: !project.archived })}
            >
              {project.archived ? "アーカイブ解除" : "アーカイブする"}
            </button>
            <button
              type="button"
              className="confirm-confirm-btn"
              onClick={onAskDelete}
            >
              完全削除
            </button>
          </div>
        </div>
      )}
    </li>
  );
}
