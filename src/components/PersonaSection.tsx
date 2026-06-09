"use client";

/**
 * 秘書の persona 設定セクション。
 * - 秘書の名前 / よみがな
 * - ユーザーの呼び方 (仕事モード / リラックスモード それぞれ)
 * - 現在モード (work / relax)
 */
import { useEffect, useState } from "react";
import VrmGallerySection from "./VrmGallerySection";
import PromptPresetsSection from "./PromptPresetsSection";

type PersonaMode = "auto" | "work" | "relax";

type Persona = {
  secretaryName: string;
  secretaryNameReading: string;
  userAddressWork: string;
  userAddressRelax: string;
  currentMode: PersonaMode;
  updatedAt: string;
};

const DEFAULTS: Persona = {
  secretaryName: "結衣",
  secretaryNameReading: "ゆい",
  userAddressWork: "ご主人様",
  userAddressRelax: "ご主人様",
  currentMode: "auto",
  updatedAt: "",
};

export default function PersonaSection() {
  const [draft, setDraft] = useState<Persona>(DEFAULTS);
  const [original, setOriginal] = useState<Persona>(DEFAULTS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(
    null
  );

  async function reload() {
    setLoading(true);
    try {
      const res = await fetch("/api/settings/persona", { cache: "no-store" });
      const data = (await res.json()) as Persona;
      setDraft(data);
      setOriginal(data);
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    // 初回 mount 時の data fetch。reload() 内の setState はサーバ応答の async 後に
    // 走るので cascade ではなく external sync (= 公式 docs OK パターン)。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();
  }, []);

  const dirty =
    draft.secretaryName !== original.secretaryName ||
    draft.secretaryNameReading !== original.secretaryNameReading ||
    draft.userAddressWork !== original.userAddressWork ||
    draft.userAddressRelax !== original.userAddressRelax ||
    draft.currentMode !== original.currentMode;

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    setFlash(null);
    try {
      const res = await fetch("/api/settings/persona", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secretaryName: draft.secretaryName,
          secretaryNameReading: draft.secretaryNameReading,
          userAddressWork: draft.userAddressWork,
          userAddressRelax: draft.userAddressRelax,
          currentMode: draft.currentMode,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      setDraft(data);
      setOriginal(data);
      setFlash({ kind: "ok", text: "保存しました" });
      // 他コンポーネント (チャットヘッダ等) に通知
      window.dispatchEvent(new CustomEvent("yui-persona-change"));
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setSaving(false);
    }
  }

  function reset() {
    setDraft(original);
    setFlash(null);
  }

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2>秘書の設定</h2>
        <p className="settings-section-sub">
          名前と呼び方を変更できます。モードによって呼び方を切り替えられます。
        </p>
      </div>

      <div className="settings-section-body">
        {flash && (
          <div className={`settings-flash settings-flash-${flash.kind}`}>
            {flash.text}
            <button onClick={() => setFlash(null)} aria-label="閉じる">×</button>
          </div>
        )}

        {loading ? (
          <p className="settings-muted">読み込み中…</p>
        ) : (
          <div className="persona-grid">
            <label className="persona-field">
              <span className="persona-label">秘書の名前</span>
              <input
                name="persona-secretary-name"
                type="text"
                value={draft.secretaryName}
                onChange={(e) => setDraft({ ...draft, secretaryName: e.target.value })}
                placeholder="結衣"
                className="persona-input"
              />
            </label>
            <label className="persona-field">
              <span className="persona-label">よみがな (TTS 用)</span>
              <input
                name="persona-secretary-name-reading"
                type="text"
                value={draft.secretaryNameReading}
                onChange={(e) =>
                  setDraft({ ...draft, secretaryNameReading: e.target.value })
                }
                placeholder="ゆい"
                className="persona-input"
              />
            </label>
            <label className="persona-field">
              <span className="persona-label">仕事モードでの呼び方</span>
              <input
                name="persona-user-address-work"
                type="text"
                value={draft.userAddressWork}
                onChange={(e) => setDraft({ ...draft, userAddressWork: e.target.value })}
                placeholder="ご主人様"
                className="persona-input"
              />
            </label>
            <label className="persona-field">
              <span className="persona-label">リラックスモードでの呼び方</span>
              <input
                name="persona-user-address-relax"
                type="text"
                value={draft.userAddressRelax}
                onChange={(e) =>
                  setDraft({ ...draft, userAddressRelax: e.target.value })
                }
                placeholder="ご主人様"
                className="persona-input"
              />
            </label>
            <fieldset className="persona-field persona-field-full">
              <legend className="persona-label">現在のモード</legend>
              <div className="persona-mode-row">
                <label className="persona-mode-opt">
                  <input
                    type="radio"
                    name="current-mode"
                    value="auto"
                    checked={draft.currentMode === "auto"}
                    onChange={() => setDraft({ ...draft, currentMode: "auto" })}
                  />
                  <span>自動 (会話で切替)</span>
                </label>
                <label className="persona-mode-opt">
                  <input
                    type="radio"
                    name="current-mode"
                    value="work"
                    checked={draft.currentMode === "work"}
                    onChange={() => setDraft({ ...draft, currentMode: "work" })}
                  />
                  <span>仕事モード固定</span>
                </label>
                <label className="persona-mode-opt">
                  <input
                    type="radio"
                    name="current-mode"
                    value="relax"
                    checked={draft.currentMode === "relax"}
                    onChange={() => setDraft({ ...draft, currentMode: "relax" })}
                  />
                  <span>リラックス固定</span>
                </label>
              </div>
            </fieldset>
          </div>
        )}

        {!loading && (
          <div className="settings-row" style={{ marginTop: 8 }}>
            <button
              type="button"
              className="settings-btn settings-btn-primary"
              disabled={!dirty || saving}
              onClick={save}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {dirty && !saving && (
              <button type="button" className="settings-btn" onClick={reset}>
                取消
              </button>
            )}
          </div>
        )}
      </div>

      <PromptPresetsSection />
      <VrmGallerySection />
    </section>
  );
}
