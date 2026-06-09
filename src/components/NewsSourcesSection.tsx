"use client";

/**
 * ニュースソース管理 (SettingsModal の「ニュース」タブ)。
 * news_sources テーブルの追加 / 削除 / 編集 (name, url) / 有効無効トグル。
 * 1 時間毎の news-fetch periodic がこの設定を読んで RSS を取得する。
 */
import { useCallback, useEffect, useState } from "react";

type Source = {
  id: number;
  name: string;
  url: string;
  enabled: boolean;
};

export default function NewsSourcesSection() {
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<Source | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/news/sources");
      if (!res.ok) return;
      const data = (await res.json()) as { sources: Source[] };
      setSources(data.sources ?? []);
    } catch (e) {
      console.warn("[news-sources] reload failed:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回 mount + reload 変化時に news sources を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();
  }, [reload]);

  const toggleEnabled = async (s: Source) => {
    setSources((cur) =>
      cur.map((x) => (x.id === s.id ? { ...x, enabled: !x.enabled } : x))
    );
    try {
      await fetch(`/api/news/sources/${s.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: !s.enabled }),
      });
    } catch (e) {
      console.warn("[news-sources] toggle failed:", e);
    }
  };

  const updateField = async (id: number, patch: Partial<Source>) => {
    setSources((cur) => cur.map((x) => (x.id === id ? { ...x, ...patch } : x)));
    try {
      await fetch(`/api/news/sources/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch (e) {
      console.warn("[news-sources] update failed:", e);
    }
  };

  const createSource = async () => {
    const name = newName.trim();
    const url = newUrl.trim();
    if (!name || !url) return;
    try {
      const res = await fetch("/api/news/sources", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, url }),
      });
      if (!res.ok) return;
      setNewName("");
      setNewUrl("");
      setCreating(false);
      await reload();
    } catch (e) {
      console.warn("[news-sources] create failed:", e);
    }
  };

  const executeDelete = async () => {
    if (!confirmDelete) return;
    const id = confirmDelete.id;
    setConfirmDelete(null);
    try {
      const res = await fetch(`/api/news/sources/${id}`, { method: "DELETE" });
      if (res.ok) {
        setSources((cur) => cur.filter((x) => x.id !== id));
      }
    } catch (e) {
      console.warn("[news-sources] delete failed:", e);
    }
  };

  return (
    <div className="news-sources">
      <div className="news-sources-head">
        <p className="news-sources-desc">
          RSS フィードを登録すると、1 時間毎に新着記事を取得して「お便り」通知に
          まとめて届けます。
        </p>
        <button
          type="button"
          className="todo-add-btn"
          onClick={() => setCreating(true)}
        >
          ＋ 追加
        </button>
      </div>

      {loading && sources.length === 0 ? (
        <div className="settings-placeholder">読み込み中…</div>
      ) : sources.length === 0 ? (
        <div className="settings-placeholder">ニュースソースが登録されていません</div>
      ) : (
        <div className="news-sources-list">
          {sources.map((s) => (
            <NewsSourceRow
              key={s.id}
              source={s}
              onToggle={() => void toggleEnabled(s)}
              onUpdate={(patch) => void updateField(s.id, patch)}
              onDelete={() => setConfirmDelete(s)}
            />
          ))}
        </div>
      )}

      {creating && (
        <div
          className="confirm-popup-backdrop"
          role="presentation"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setCreating(false);
              setNewName("");
              setNewUrl("");
            }
          }}
        >
          <div className="confirm-popup confirm-popup-accent" role="dialog" aria-modal="true">
            <h2 className="confirm-popup-title">ニュースソースを追加</h2>
            <div className="dictionary-popup-fields">
              <label className="project-edit-label">
                <span>名前</span>
                <input
                  name="news-source-new-name"
                  type="text"
                  value={newName}
                  autoFocus
                  onChange={(e) => setNewName(e.target.value)}
                  placeholder="例: 朝日新聞"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createSource();
                    }
                  }}
                />
              </label>
              <label className="project-edit-label">
                <span>RSS URL</span>
                <input
                  name="news-source-new-url"
                  type="text"
                  value={newUrl}
                  onChange={(e) => setNewUrl(e.target.value)}
                  placeholder="https://..."
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void createSource();
                    }
                  }}
                />
              </label>
            </div>
            <div className="confirm-popup-actions">
              <button
                type="button"
                className="confirm-cancel-btn"
                onClick={() => {
                  setCreating(false);
                  setNewName("");
                  setNewUrl("");
                }}
              >
                キャンセル
              </button>
              <button
                type="button"
                className="confirm-confirm-btn"
                onClick={() => void createSource()}
                disabled={!newName.trim() || !newUrl.trim()}
              >
                追加
              </button>
            </div>
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
          <div className="confirm-popup" role="dialog" aria-modal="true">
            <h2 className="confirm-popup-title">ソース削除の確認</h2>
            <p className="confirm-popup-body">
              <strong className="confirm-popup-target">「{confirmDelete.name}」</strong>
              を削除しますか?
              <br />
              <span className="confirm-popup-note">関連する記事も全て削除されます。</span>
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
                削除する
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function NewsSourceRow({
  source,
  onToggle,
  onUpdate,
  onDelete,
}: {
  source: Source;
  onToggle: () => void;
  onUpdate: (patch: { name?: string; url?: string }) => void;
  onDelete: () => void;
}) {
  const [name, setName] = useState(source.name);
  const [url, setUrl] = useState(source.url);

  // source prop 変化時に編集中の値を同期。anti-pattern #4 (key prop) follow-up。
  /* eslint-disable react-hooks/set-state-in-effect */
  useEffect(() => {
    setName(source.name);
    setUrl(source.url);
  }, [source.name, source.url]);
  /* eslint-enable react-hooks/set-state-in-effect */

  return (
    <div className={`news-source-row ${source.enabled ? "" : "disabled"}`}>
      <button
        type="button"
        className={`news-source-toggle ${source.enabled ? "on" : "off"}`}
        onClick={onToggle}
        aria-label={source.enabled ? "無効化" : "有効化"}
        title={source.enabled ? "有効中 (クリックで無効化)" : "無効 (クリックで有効化)"}
      >
        <span className="news-source-toggle-knob" />
      </button>
      <div className="news-source-fields">
        <input
          name="news-source-name"
          type="text"
          className="news-source-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            const v = name.trim();
            if (v && v !== source.name) onUpdate({ name: v });
            else if (!v) setName(source.name);
          }}
        />
        <input
          name="news-source-url"
          type="text"
          className="news-source-url"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => {
            const v = url.trim();
            if (v && v !== source.url && /^https?:\/\//.test(v)) onUpdate({ url: v });
            else if (!/^https?:\/\//.test(v)) setUrl(source.url);
          }}
        />
      </div>
      <button
        type="button"
        className="news-source-delete"
        onClick={onDelete}
        aria-label="削除"
        title="削除"
      >
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1.5 14a2 2 0 0 1-2 1.8H8.5a2 2 0 0 1-2-1.8L5 6" />
          <path d="M10 11v6M14 11v6" />
        </svg>
      </button>
    </div>
  );
}
