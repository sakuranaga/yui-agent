"use client";

/**
 * SettingsModal「記憶」タブ。memory_chunks を直接編集する管理 UI。
 *
 * - フィルタ: chunk_type / owner / 検索 / 無効化済も表示
 * - 行: 種別バッジ + owner バッジ + importance スライダー + content (inline 編集) + 操作
 * - 操作: 無効化 / 再有効化 / 完全削除 / 手動追加
 *
 * 設計: docs/memory-architecture.md §16.7 Phase 2
 */
import { useCallback, useEffect, useState } from "react";

type Chunk = {
  id: number;
  chunkType: string;
  owner: "user" | "assistant" | "shared";
  content: string;
  importance: number;
  actorType: string;
  createdAt: string;
  invalidatedAt: string | null;
};

const TYPE_OPTIONS = [
  "fact",
  "preference",
  "event",
  "emotion",
  "summary",
  "turn_summary",
  "procedural",
  "commitment",
  "task_result",
  "external_ref",
] as const;

const TYPE_LABEL: Record<string, string> = {
  fact: "事実",
  preference: "嗜好",
  event: "出来事",
  emotion: "感情",
  summary: "要約",
  turn_summary: "ターン要約",
  procedural: "手順",
  commitment: "約束",
  task_result: "タスク結果",
  external_ref: "外部参照",
};

type Stats = {
  total: number;
  valid: number;
  invalidated: number;
  byType: Record<string, number>;
  byOwner: Record<string, number>;
  importanceBands: Record<string, number>;
  decay: {
    lastRunAt: string | null;
    lastRunDecayed: number;
    lastRunInvalidated: number;
    decayedLast7d: number;
    invalidatedLast7d: number;
  };
  topReinforced: Array<{
    id: number;
    content: string;
    importance: number;
    owner: string;
    reinforceCount: number;
  }>;
  retrievalActivity: { totalLast7d: number; uniqueChunksLast7d: number };
};

export default function MemorySection() {
  const [chunks, setChunks] = useState<Chunk[]>([]);
  const [loading, setLoading] = useState(true);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [ownerFilter, setOwnerFilter] = useState<string>("");
  const [q, setQ] = useState("");
  const [qDebounced, setQDebounced] = useState("");
  const [includeInvalidated, setIncludeInvalidated] = useState(false);
  const [creating, setCreating] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<Chunk | null>(null);
  const [stats, setStats] = useState<Stats | null>(null);
  const [showStats, setShowStats] = useState(false);

  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/memory/stats");
        if (!res.ok) return;
        setStats(await res.json());
      } catch (e) {
        console.warn("[memory] stats load failed:", e);
      }
    })();
  }, []);

  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (typeFilter) params.set("type", typeFilter);
      if (ownerFilter) params.set("owner", ownerFilter);
      if (qDebounced) params.set("q", qDebounced);
      if (includeInvalidated) params.set("include_invalidated", "1");
      params.set("limit", "200");
      const res = await fetch(`/api/memory?${params.toString()}`);
      if (!res.ok) return;
      const data = (await res.json()) as { chunks: Chunk[] };
      setChunks(data.chunks ?? []);
    } catch (e) {
      console.warn("[memory] load failed:", e);
    } finally {
      setLoading(false);
    }
  }, [typeFilter, ownerFilter, qDebounced, includeInvalidated]);

  useEffect(() => {
    // 初回 mount + filter 変化時に再 fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount/filter-change fetch
    void reload();
  }, [reload]);

  const patchChunk = async (id: number, patch: Partial<Chunk>) => {
    setChunks((cur) => cur.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      await fetch(`/api/memory/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (e) {
      console.warn("[memory] patch failed:", e);
    }
  };

  const invalidate = async (id: number) => {
    setChunks((cur) =>
      cur.map((x) =>
        x.id === id ? { ...x, invalidatedAt: new Date().toISOString() } : x
      )
    );
    try {
      await fetch(`/api/memory/${id}/invalidate`, { method: "POST" });
    } catch (e) {
      console.warn("[memory] invalidate failed:", e);
    }
  };

  const revalidate = async (id: number) => {
    setChunks((cur) => cur.map((x) => (x.id === id ? { ...x, invalidatedAt: null } : x)));
    try {
      await fetch(`/api/memory/${id}/invalidate`, { method: "DELETE" });
    } catch (e) {
      console.warn("[memory] revalidate failed:", e);
    }
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    setConfirmDelete(null);
    try {
      await fetch(`/api/memory/${id}`, { method: "DELETE" });
      setChunks((cur) => cur.filter((x) => x.id !== id));
    } catch (e) {
      console.warn("[memory] delete failed:", e);
    }
  };

  // 統計バーは server stats (フィルタに依らず DB 全体)。
  // フィルタで絞り込まれた件数を見たければ chunks.length を別途。
  const localStatsForChunks = stats?.byOwner ?? {};

  return (
    <div className="memory-section">
      <div className="memory-head">
        <div className="memory-stats">
          <span>有効: <strong>{stats?.valid ?? 0}</strong></span>
          <span>ご主人様: <strong>{localStatsForChunks.user ?? 0}</strong></span>
          <span>秘書: <strong>{localStatsForChunks.assistant ?? 0}</strong></span>
          <span>両者: <strong>{localStatsForChunks.shared ?? 0}</strong></span>
          <button
            type="button"
            className="memory-stats-toggle"
            onClick={() => setShowStats((v) => !v)}
            title="統計パネルを表示/非表示"
          >
            {showStats ? "▲ 統計を閉じる" : "▼ 統計を見る"}
          </button>
        </div>
        <button type="button" className="todo-add-btn" onClick={() => setCreating(true)}>
          ＋ 追加
        </button>
      </div>

      {showStats && stats && <StatsPanel stats={stats} />}

      <div className="memory-filters">
        <input
          name="memory-search"
          type="text"
          className="memory-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="検索 (本文部分一致)"
        />
        <select
          className="memory-select"
          value={typeFilter}
          onChange={(e) => setTypeFilter(e.target.value)}
        >
          <option value="">全種類</option>
          {TYPE_OPTIONS.map((t) => (
            <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>
          ))}
        </select>
        <select
          className="memory-select"
          value={ownerFilter}
          onChange={(e) => setOwnerFilter(e.target.value)}
        >
          <option value="">全 owner</option>
          <option value="user">ご主人様</option>
          <option value="assistant">秘書</option>
          <option value="shared">両者</option>
        </select>
        <label className="memory-toggle">
          <input
            type="checkbox"
            checked={includeInvalidated}
            onChange={(e) => setIncludeInvalidated(e.target.checked)}
          />
          無効化済も表示
        </label>
      </div>

      {loading && chunks.length === 0 ? (
        <div className="settings-placeholder">読み込み中…</div>
      ) : chunks.length === 0 ? (
        <div className="settings-placeholder">該当する記憶がありません</div>
      ) : (
        <ul className="memory-list">
          {chunks.map((c) => (
            <MemoryRow
              key={c.id}
              chunk={c}
              onPatch={(p) => void patchChunk(c.id, p)}
              onInvalidate={() => void invalidate(c.id)}
              onRevalidate={() => void revalidate(c.id)}
              onDelete={() => setConfirmDelete(c)}
            />
          ))}
        </ul>
      )}

      {creating && (
        <CreateForm
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            void reload();
          }}
        />
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
            <h2 className="confirm-popup-title">記憶の完全削除</h2>
            <p className="confirm-popup-body">
              <strong className="confirm-popup-target">「{confirmDelete.content.slice(0, 40)}…」</strong>
              を <strong>物理削除</strong> しますか?
              <br />
              <span className="confirm-popup-note">
                この操作は取り消せません。記憶を「無効化」するだけなら本体ボタンを使ってください
                (行は残り、後から復元できます)。
              </span>
            </p>
            <div className="confirm-popup-actions">
              <button type="button" className="confirm-cancel-btn" onClick={() => setConfirmDelete(null)}>
                キャンセル
              </button>
              <button
                type="button"
                className="confirm-confirm-btn"
                onClick={() => void executeDelete()}
                autoFocus
              >
                完全削除
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MemoryRow({
  chunk,
  onPatch,
  onInvalidate,
  onRevalidate,
  onDelete,
}: {
  chunk: Chunk;
  onPatch: (patch: Partial<Chunk>) => void;
  onInvalidate: () => void;
  onRevalidate: () => void;
  onDelete: () => void;
}) {
  const [content, setContent] = useState(chunk.content);
  const [editing, setEditing] = useState(false);

  // chunk prop が変わったら編集中の content を同期 (= 親が別 chunk を表示要求した時)。
  // 公式 anti-pattern #4 (key prop 推奨) follow-up。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- prop sync, key prop の follow-up
    setContent(chunk.content);
  }, [chunk.content]);

  const dead = !!chunk.invalidatedAt;
  return (
    <li className={`memory-row ${dead ? "invalidated" : ""}`}>
      <div className="memory-row-head">
        <span className={`memory-badge type type-${chunk.chunkType}`}>
          {TYPE_LABEL[chunk.chunkType] ?? chunk.chunkType}
        </span>
        <select
          className={`memory-owner-select owner-${chunk.owner}`}
          value={chunk.owner}
          onChange={(e) => onPatch({ owner: e.target.value as Chunk["owner"] })}
          aria-label="owner"
        >
          <option value="user">ご主人様</option>
          <option value="assistant">秘書</option>
          <option value="shared">両者</option>
        </select>
        <span className="memory-importance">
          <input
            name="memory-importance"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={chunk.importance}
            onChange={(e) => onPatch({ importance: Number(e.target.value) })}
          />
          <span className="memory-importance-value">{chunk.importance.toFixed(2)}</span>
        </span>
        <span className="memory-meta">
          {chunk.actorType}・{fmtDate(chunk.createdAt)}
        </span>
        <span className="memory-actions">
          {dead ? (
            <button
              type="button"
              className="memory-action-revalidate"
              onClick={onRevalidate}
              title="再有効化"
            >
              復元
            </button>
          ) : (
            <button
              type="button"
              className="memory-action-invalidate"
              onClick={onInvalidate}
              title="無効化 (retrieval から非表示、行は残る)"
            >
              無効化
            </button>
          )}
          <button
            type="button"
            className="memory-action-delete"
            onClick={onDelete}
            title="完全削除 (取り消し不可)"
          >
            ×
          </button>
        </span>
      </div>
      {editing ? (
        <textarea
          name="memory-content-edit"
          className="memory-content-edit"
          value={content}
          autoFocus
          onChange={(e) => setContent(e.target.value)}
          onBlur={() => {
            const v = content.trim();
            setEditing(false);
            if (v && v !== chunk.content) onPatch({ content: v });
            else if (!v) setContent(chunk.content);
          }}
          rows={Math.max(2, Math.min(6, content.split("\n").length))}
        />
      ) : (
        <div
          className="memory-content"
          onClick={() => setEditing(true)}
          title="クリックで編集"
        >
          {chunk.content}
        </div>
      )}
    </li>
  );
}

function CreateForm({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const [chunkType, setChunkType] = useState<string>("preference");
  const [owner, setOwner] = useState<"user" | "assistant" | "shared">("user");
  const [content, setContent] = useState("");
  const [importance, setImportance] = useState(0.6);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!content.trim() || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/memory", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chunkType, owner, content: content.trim(), importance }),
      });
      if (res.ok) onCreated();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="confirm-popup-backdrop"
      role="presentation"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="confirm-popup confirm-popup-accent" role="dialog" aria-modal="true">
        <h2 className="confirm-popup-title">記憶を追加</h2>
        <div className="memory-create-fields">
          <label className="project-edit-label">
            <span>種類</span>
            <select value={chunkType} onChange={(e) => setChunkType(e.target.value)}>
              {TYPE_OPTIONS.map((t) => (
                <option key={t} value={t}>{TYPE_LABEL[t] ?? t}</option>
              ))}
            </select>
          </label>
          <label className="project-edit-label">
            <span>誰について</span>
            <select value={owner} onChange={(e) => setOwner(e.target.value as typeof owner)}>
              <option value="user">ご主人様</option>
              <option value="assistant">秘書</option>
              <option value="shared">両者</option>
            </select>
          </label>
          <label className="project-edit-label">
            <span>重要度: {importance.toFixed(2)}</span>
            <input
              name="new-memory-importance"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={importance}
              onChange={(e) => setImportance(Number(e.target.value))}
            />
          </label>
          <label className="project-edit-label">
            <span>内容</span>
            <textarea
              name="new-memory-content"
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={3}
              placeholder="例: ご主人様はクラシック音楽が好き"
              autoFocus
            />
          </label>
        </div>
        <div className="confirm-popup-actions">
          <button type="button" className="confirm-cancel-btn" onClick={onClose}>
            キャンセル
          </button>
          <button
            type="button"
            className="confirm-confirm-btn"
            onClick={() => void submit()}
            disabled={!content.trim() || busy}
          >
            {busy ? "追加中…" : "追加"}
          </button>
        </div>
      </div>
    </div>
  );
}

function fmtDate(iso: string): string {
  const d = new Date(iso);
  const fmt = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
  });
  return fmt.format(d);
}

function StatsPanel({ stats }: { stats: Stats }) {
  const total = stats.valid + stats.invalidated;
  return (
    <div className="memory-stats-panel">
      <div className="memory-stats-grid">
        <div className="memory-stats-card">
          <div className="memory-stats-card-title">総数</div>
          <div className="memory-stats-card-value">{total}</div>
          <div className="memory-stats-card-sub">
            有効 {stats.valid} ・ 無効 {stats.invalidated}
          </div>
        </div>
        <div className="memory-stats-card">
          <div className="memory-stats-card-title">重要度分布</div>
          <div className="memory-stats-card-bars">
            <span title="0.9 以上 (絶対忘れない)">
              <em>{stats.importanceBands["0.9+"]}</em> 高
            </span>
            <span title="0.7-0.9">
              <em>{stats.importanceBands["0.7+"]}</em> 中高
            </span>
            <span title="0.5-0.7">
              <em>{stats.importanceBands["0.5+"]}</em> 中
            </span>
            <span title="0.5 未満">
              <em>{stats.importanceBands["<0.5"]}</em> 低
            </span>
          </div>
        </div>
        <div className="memory-stats-card">
          <div className="memory-stats-card-title">最終 decay</div>
          <div className="memory-stats-card-value">
            {stats.decay.lastRunAt
              ? new Date(stats.decay.lastRunAt).toLocaleDateString("ja-JP")
              : "未実行"}
          </div>
          <div className="memory-stats-card-sub">
            7 日間: 減衰 {stats.decay.decayedLast7d} ・ 無効化 {stats.decay.invalidatedLast7d}
          </div>
        </div>
        <div className="memory-stats-card">
          <div className="memory-stats-card-title">retrieval 活動</div>
          <div className="memory-stats-card-value">{stats.retrievalActivity.totalLast7d}</div>
          <div className="memory-stats-card-sub">
            7 日間 / 参照 chunk 数 {stats.retrievalActivity.uniqueChunksLast7d}
          </div>
        </div>
      </div>
      {stats.topReinforced.length > 0 && (
        <div className="memory-stats-reinforced">
          <div className="memory-stats-card-title">再強化された記憶 (top {stats.topReinforced.length})</div>
          <ul>
            {stats.topReinforced.map((r) => (
              <li key={r.id}>
                <span className="memory-stats-reinforced-count">×{r.reinforceCount}</span>
                <span className="memory-stats-reinforced-content">{r.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
