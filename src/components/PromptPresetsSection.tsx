"use client";

/**
 * 追加プロンプトのプリセット管理 (設定 > 秘書 タブ内)。
 *
 * - 複数の preset を登録可能 (label + body)
 * - そのうち 1 つだけを「有効化」、もしくは「なし」
 * - 有効化中の preset 本文は yui-prompt で base persona の末尾に append される
 *
 * 基本 persona (`yui-prompt.ts`) は触らせない方針 (システム崩壊の防止)。
 * ユーザがカスタムしたい指示はここから差し込む。
 */
import { useCallback, useEffect, useState } from "react";

type Preset = {
  id: number;
  label: string;
  body: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type Persona = {
  activePromptPresetId: number | null;
};

export default function PromptPresetsSection() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Preset | null>(null);   // 編集中 (id != null)
  const [creating, setCreating] = useState(false);
  const [draftLabel, setDraftLabel] = useState("");
  const [draftBody, setDraftBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const loadAll = useCallback(async () => {
    setLoading(true);
    try {
      const [presetsRes, personaRes] = await Promise.all([
        fetch("/api/prompt-presets", { cache: "no-store" }),
        fetch("/api/settings/persona", { cache: "no-store" }),
      ]);
      if (presetsRes.ok) {
        const data = (await presetsRes.json()) as { presets: Preset[] };
        setPresets(data.presets);
      }
      if (personaRes.ok) {
        const p = (await personaRes.json()) as Persona;
        setActiveId(p.activePromptPresetId ?? null);
      }
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // 初回 mount + loadAll 関数更新時に再 fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void loadAll();
  }, [loadAll]);

  const setActive = async (id: number | null) => {
    setBusy(true);
    setFlash(null);
    try {
      const res = await fetch("/api/settings/persona", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ activePromptPresetId: id }),
      });
      if (res.ok) {
        setActiveId(id);
        setFlash({ kind: "ok", text: id === null ? "追加プロンプトをなしにしました" : "有効化しました" });
      } else {
        const j = await res.json().catch(() => ({}));
        setFlash({ kind: "err", text: `失敗: ${j.error ?? res.status}` });
      }
    } finally {
      setBusy(false);
    }
  };

  const openCreate = () => {
    setCreating(true);
    setEditing(null);
    setDraftLabel("");
    setDraftBody("");
  };
  const openEdit = (p: Preset) => {
    setCreating(false);
    setEditing(p);
    setDraftLabel(p.label);
    setDraftBody(p.body);
  };
  const cancel = () => {
    setCreating(false);
    setEditing(null);
    setDraftLabel("");
    setDraftBody("");
  };

  const submit = async () => {
    if (draftLabel.trim() === "" || draftBody.trim() === "") return;
    setBusy(true);
    setFlash(null);
    try {
      if (creating) {
        const res = await fetch("/api/prompt-presets", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: draftLabel.trim(), body: draftBody.trim() }),
        });
        if (res.ok) {
          await loadAll();
          cancel();
          setFlash({ kind: "ok", text: "追加しました" });
        } else {
          const j = await res.json().catch(() => ({}));
          setFlash({ kind: "err", text: `失敗: ${j.error ?? res.status}` });
        }
      } else if (editing) {
        const res = await fetch(`/api/prompt-presets/${editing.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ label: draftLabel.trim(), body: draftBody.trim() }),
        });
        if (res.ok) {
          await loadAll();
          cancel();
          setFlash({ kind: "ok", text: "更新しました" });
        } else {
          const j = await res.json().catch(() => ({}));
          setFlash({ kind: "err", text: `失敗: ${j.error ?? res.status}` });
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const remove = async (p: Preset) => {
    if (!confirm(`「${p.label}」を削除します。よろしいですか?`)) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/prompt-presets/${p.id}`, { method: "DELETE" });
      if (res.ok) {
        await loadAll();
        setFlash({ kind: "ok", text: "削除しました" });
      } else {
        const j = await res.json().catch(() => ({}));
        setFlash({ kind: "err", text: `失敗: ${j.error ?? res.status}` });
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="prompt-presets-section">
      <h3 className="ai-section-title">追加プロンプト</h3>
      <p className="ai-hint">
        基本のペルソナは触らず、その後ろに追加で渡したい指示を登録できます。
        複数登録して 1 つだけ有効化、または「なし」を選択。
      </p>

      {loading ? (
        <div className="ai-hint">読み込み中…</div>
      ) : (
        <div className="prompt-presets-list">
          <label className={`prompt-preset-row none-row${activeId === null ? " is-active" : ""}`}>
            <input
              type="radio"
              name="prompt-preset-active"
              checked={activeId === null}
              onChange={() => void setActive(null)}
              disabled={busy}
            />
            <span className="prompt-preset-label">追加なし</span>
            <span className="prompt-preset-meta">基本ペルソナのみ</span>
          </label>
          {presets.map((p) => (
            <div key={p.id} className={`prompt-preset-row${activeId === p.id ? " is-active" : ""}`}>
              <label className="prompt-preset-radio">
                <input
                  type="radio"
                  name="prompt-preset-active"
                  checked={activeId === p.id}
                  onChange={() => void setActive(p.id)}
                  disabled={busy}
                />
                <span className="prompt-preset-label">{p.label}</span>
              </label>
              <span className="prompt-preset-meta">{p.body.length} 文字</span>
              <div className="prompt-preset-actions">
                <button type="button" className="prompt-preset-btn" onClick={() => openEdit(p)}>編集</button>
                <button type="button" className="prompt-preset-btn danger" onClick={() => void remove(p)}>削除</button>
              </div>
            </div>
          ))}
        </div>
      )}

      <button
        type="button"
        className="prompt-preset-add-btn"
        onClick={openCreate}
        disabled={creating || editing !== null}
      >＋ 新規追加</button>

      {(creating || editing !== null) && (
        <div
          className="confirm-popup-backdrop"
          role="presentation"
          onClick={(e) => { if (e.target === e.currentTarget) cancel(); }}
        >
          <div className="confirm-popup confirm-popup-accent prompt-preset-popup" role="dialog" aria-modal="true">
            <h2 className="confirm-popup-title">{creating ? "プリセット追加" : "プリセット編集"}</h2>
            <div className="prompt-preset-field">
              <label>名前</label>
              <input
                name="prompt-preset-label"
                type="text"
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                placeholder="例: 短文モード、技術相談モード"
              />
            </div>
            <div className="prompt-preset-field">
              <label>本文</label>
              <textarea
                name="prompt-preset-body"
                value={draftBody}
                onChange={(e) => setDraftBody(e.target.value)}
                rows={10}
                placeholder="例: 返事は 1 文以内で短く答えてください。"
              />
              <span className="prompt-preset-charcount">{draftBody.length} 文字</span>
            </div>
            <div className="confirm-popup-actions">
              <button type="button" className="confirm-cancel-btn" onClick={cancel}>キャンセル</button>
              <button
                type="button"
                className="confirm-confirm-btn"
                onClick={() => void submit()}
                disabled={busy || draftLabel.trim() === "" || draftBody.trim() === ""}
              >{busy ? "保存中…" : creating ? "追加" : "更新"}</button>
            </div>
          </div>
        </div>
      )}

      {flash && (
        <div className={`prompt-preset-flash ${flash.kind}`}>{flash.text}</div>
      )}
    </section>
  );
}
