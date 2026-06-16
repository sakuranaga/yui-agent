"use client";

/**
 * モデルレジストリ管理 UI (#206 M4)。
 *
 * - 登録モデル一覧: 能力バッジ (到達 / tool) + テスト / 編集 / 削除 / 追加
 * - tier 割当: main / sub / heavy + fallback (main/heavy は tool 対応モデルのみ選択可)
 * - role 別上書き (折りたたみ): 役割ごとに既定 tier or 特定モデルへ
 *
 * バックエンド: /api/model-registry, /api/model-registry/[id], /[id]/test, /tiers
 * 設計: docs/model-config-overhaul.md §8.6
 */
import { useEffect, useState } from "react";

type Provider = "anthropic" | "openai" | "gemini" | "grok" | "local_openai";

type Capabilities = {
  reachable?: boolean;
  supportsTools?: boolean;
  testedAt?: string | null;
  lastError?: string | null;
};

type ModelEntry = {
  id: string;
  label: string;
  provider: Provider;
  modelId: string;
  baseUrl: string | null;
  apiKeyRef: string | null;
  capabilities: Capabilities;
};

type TierName = "main" | "sub" | "heavy";
type Tiers = {
  assignment: Record<TierName, string | null>;
  fallback: Record<TierName, string | null>;
  roleOverrides: Record<string, string>;
};

const PROVIDER_LABEL: Record<Provider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  grok: "Grok",
  local_openai: "ローカル",
};

const TIER_META: Array<{ key: TierName; label: string; hint: string; toolRequired: boolean }> = [
  { key: "main", label: "メイン", hint: "Yui 本体の応答 (tool 必須)", toolRequired: true },
  { key: "sub", label: "サブ", hint: "要約・分類など軽量背景タスク", toolRequired: false },
  { key: "heavy", label: "ヘビー", hint: "複雑タスク・専門エージェント (tool 必須)", toolRequired: true },
];

/** role → 表示名 + 既定 tier (llm.ts DEFAULT_ROLE_TIER と一致させる)。 */
const ROLE_META: Array<{ role: string; label: string; tier: TierName }> = [
  { role: "main", label: "メイン会話", tier: "main" },
  { role: "news_speak", label: "ニュース読み上げ", tier: "main" },
  { role: "diary", label: "日記生成", tier: "main" },
  { role: "sleep_intro", label: "睡眠導入", tier: "main" },
  { role: "profile_synth", label: "プロファイル生成", tier: "main" },
  { role: "voice", label: "口調整形", tier: "sub" },
  { role: "judge", label: "ディスパッチ判定", tier: "sub" },
  { role: "report", label: "ノート整形", tier: "sub" },
  { role: "extract", label: "記憶抽出", tier: "sub" },
  { role: "reconcile", label: "記憶の矛盾解消", tier: "sub" },
  { role: "news_curate", label: "ニュース選別", tier: "sub" },
  { role: "morning_speak", label: "朝の挨拶", tier: "sub" },
  { role: "mail_curate", label: "メール仕分け", tier: "sub" },
  { role: "tts_normalize", label: "TTS 前処理", tier: "sub" },
  { role: "food_extract", label: "食事ログ抽出", tier: "sub" },
  { role: "notify", label: "進捗連絡整形", tier: "sub" },
  { role: "specialist", label: "専門エージェント", tier: "heavy" },
];

// ───── lucide 流 inline SVG (絵文字禁止) ─────
function IconCheck() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
function IconX() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}
function IconDash() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" aria-hidden="true">
      <path d="M5 12h14" />
    </svg>
  );
}
function IconChevron(props: { open: boolean }) {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      style={{ transform: props.open ? "rotate(90deg)" : "none", transition: "transform 0.15s", verticalAlign: "-2px", marginRight: 4 }}>
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function CapBadge(props: { label: string; state: boolean | undefined }) {
  const cls = props.state === true ? "ok" : props.state === false ? "err" : "unknown";
  return (
    <span className={`ai-cap-badge ${cls}`}>
      {props.state === true ? <IconCheck /> : props.state === false ? <IconX /> : <IconDash />}
      {props.label}
    </span>
  );
}

export default function ModelRegistryManager() {
  const [entries, setEntries] = useState<ModelEntry[]>([]);
  const [tiers, setTiers] = useState<Tiers | null>(null);
  const [loading, setLoading] = useState(true);
  const [testingId, setTestingId] = useState<string | null>(null);
  const [savingTiers, setSavingTiers] = useState(false);
  const [tiersMsg, setTiersMsg] = useState<string | null>(null);
  const [tiersErr, setTiersErr] = useState<string | null>(null);
  const [showRoles, setShowRoles] = useState(false);

  // 追加 / 編集フォーム
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState<{ label: string; provider: Provider; modelId: string; baseUrl: string }>({
    label: "", provider: "anthropic", modelId: "", baseUrl: "",
  });
  const [editId, setEditId] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);

  const load = async () => {
    // setLoading(true) は付けない (= 初期値 true + reload 時のちらつき防止 + effect 内同期 setState 回避)
    try {
      const [er, tr] = await Promise.all([
        fetch("/api/model-registry", { cache: "no-store" }),
        fetch("/api/model-registry/tiers", { cache: "no-store" }),
      ]);
      if (er.ok) setEntries(((await er.json()) as { entries: ModelEntry[] }).entries);
      if (tr.ok) setTiers((await tr.json()) as Tiers);
    } catch (e) {
      console.warn("[model-registry] load failed:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void load();
  }, []);

  const testEntry = async (id: string) => {
    setTestingId(id);
    try {
      const res = await fetch(`/api/model-registry/${id}/test`, { method: "POST" });
      if (res.ok) {
        const { capabilities } = (await res.json()) as { capabilities: Capabilities };
        setEntries((es) => es.map((e) => (e.id === id ? { ...e, capabilities } : e)));
      }
    } catch (e) {
      console.warn("[model-registry] test failed:", e);
    } finally {
      setTestingId(null);
    }
  };

  const deleteEntry = async (id: string) => {
    try {
      const res = await fetch(`/api/model-registry/${id}`, { method: "DELETE" });
      if (res.ok) {
        await load();
      } else {
        const body = (await res.json()) as { error?: string; references?: string[] };
        alert(`${body.error ?? "削除に失敗しました"}${body.references ? `\n参照中: ${body.references.join(" / ")}` : ""}`);
      }
    } catch (e) {
      console.warn("[model-registry] delete failed:", e);
    }
  };

  const submitForm = async () => {
    setFormErr(null);
    const payload = {
      label: form.label.trim(),
      provider: form.provider,
      modelId: form.modelId.trim(),
      ...(form.provider === "local_openai" ? { baseUrl: form.baseUrl.trim() } : {}),
    };
    try {
      const res = editId
        ? await fetch(`/api/model-registry/${editId}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/model-registry", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (res.ok) {
        setAdding(false);
        setEditId(null);
        setForm({ label: "", provider: "anthropic", modelId: "", baseUrl: "" });
        await load();
      } else {
        const body = (await res.json()) as { error?: string; references?: string[] };
        setFormErr(`${body.error ?? "保存に失敗しました"}${body.references ? ` (参照中: ${body.references.join(" / ")})` : ""}`);
      }
    } catch (e) {
      setFormErr(e instanceof Error ? e.message : "保存に失敗しました");
    }
  };

  const startEdit = (e: ModelEntry) => {
    setEditId(e.id);
    setAdding(true);
    setFormErr(null);
    setForm({ label: e.label, provider: e.provider, modelId: e.modelId, baseUrl: e.baseUrl ?? "" });
  };

  const saveTiers = async () => {
    if (!tiers) return;
    setSavingTiers(true);
    setTiersMsg(null);
    setTiersErr(null);
    try {
      const res = await fetch("/api/model-registry/tiers", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(tiers),
      });
      if (res.ok) {
        setTiers((await res.json()) as Tiers);
        setTiersMsg("保存しました");
        setTimeout(() => setTiersMsg(null), 2500);
      } else if (res.status === 422) {
        const body = (await res.json()) as { error?: string; violations?: Array<{ slot: string; reason: string }> };
        setTiersErr(`${body.error ?? "保存できません"}${body.violations ? `\n${body.violations.map((v) => `・${v.slot}: ${v.reason}`).join("\n")}` : ""}`);
      } else {
        const body = (await res.json()) as { error?: string };
        setTiersErr(body.error ?? "保存に失敗しました");
      }
    } catch (e) {
      setTiersErr(e instanceof Error ? e.message : "保存に失敗しました");
    } finally {
      setSavingTiers(false);
    }
  };

  const setAssign = (tier: TierName, kind: "assignment" | "fallback", value: string) => {
    setTiers((t) => (t ? { ...t, [kind]: { ...t[kind], [tier]: value || null } } : t));
  };
  const setRoleOverride = (role: string, value: string) => {
    setTiers((t) => {
      if (!t) return t;
      const next = { ...t.roleOverrides };
      if (value) next[role] = value;
      else delete next[role];
      return { ...t, roleOverrides: next };
    });
  };

  if (loading) return <div className="settings-placeholder">読み込み中…</div>;

  // 未対応理由のラベル (未テスト と tested-非対応 を区別)。
  const disabledSuffix = (e: ModelEntry) =>
    e.capabilities.supportsTools === false ? " (tool 非対応)" : " (要テスト)";

  // tier ドロップダウンの選択肢 (tool 必須枠は supportsTools のみ enabled)
  const tierOptions = (toolRequired: boolean) =>
    entries.map((e) => {
      const disabled = toolRequired && e.capabilities.supportsTools !== true;
      return (
        <option key={e.id} value={e.id} disabled={disabled}>
          {e.label}{disabled ? disabledSuffix(e) : ""}
        </option>
      );
    });

  return (
    <>
      {/* === 登録モデル === */}
      <section className="ai-card">
        <h3 className="ai-card-title">登録モデル</h3>
        <p className="ai-card-note">
          hosted (Anthropic / OpenAI / Gemini / Grok) とローカル (OpenAI 互換) のモデルを登録します。
          「テスト」で到達性と tool 対応を確認すると、メイン / ヘビー 枠に割り当てられるようになります。
        </p>

        <div className="ai-model-list">
          {entries.length === 0 && <div className="ai-hint">モデルが登録されていません。</div>}
          {entries.map((e) => (
            <div key={e.id} className="ai-model-row">
              <div className="ai-model-info">
                <div className="ai-model-head">
                  <span className="ai-model-label">{e.label}</span>
                  <span className="ai-model-provider">{PROVIDER_LABEL[e.provider]}</span>
                </div>
                <div className="ai-model-id">{e.modelId}{e.baseUrl ? ` · ${e.baseUrl}` : ""}</div>
                <div className="ai-cap-badges">
                  <CapBadge label="到達" state={e.capabilities.reachable} />
                  <CapBadge label="tool" state={e.capabilities.supportsTools} />
                  {e.capabilities.lastError && <span className="ai-cap-err">{e.capabilities.lastError}</span>}
                </div>
              </div>
              <div className="ai-model-actions">
                <button type="button" className="ai-test-btn" onClick={() => void testEntry(e.id)} disabled={testingId === e.id}>
                  {testingId === e.id ? "テスト中…" : "テスト"}
                </button>
                <button type="button" className="ai-edit-btn" onClick={() => startEdit(e)}>編集</button>
                <button type="button" className="ai-edit-btn ai-danger" onClick={() => void deleteEntry(e.id)}>削除</button>
              </div>
            </div>
          ))}
        </div>

        {adding ? (
          <div className="ai-model-form">
            <div className="ai-field">
              <label className="ai-label">ラベル (表示名)</label>
              <input className="ai-input" value={form.label} onChange={(ev) => setForm((f) => ({ ...f, label: ev.target.value }))} placeholder="例: Sonnet (メイン)" />
            </div>
            <div className="ai-field">
              <label className="ai-label">provider</label>
              <select className="ai-input" value={form.provider} disabled={editId !== null}
                onChange={(ev) => setForm((f) => ({ ...f, provider: ev.target.value as Provider }))}>
                {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => (
                  <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
                ))}
              </select>
              {editId !== null && <div className="ai-hint">provider は変更できません (作り直してください)。</div>}
            </div>
            <div className="ai-field">
              <label className="ai-label">モデル ID</label>
              <input className="ai-input" value={form.modelId} onChange={(ev) => setForm((f) => ({ ...f, modelId: ev.target.value }))} placeholder="例: claude-sonnet-4-6 / gemma-... " />
            </div>
            {form.provider === "local_openai" && (
              <div className="ai-field">
                <label className="ai-label">エンドポイント (OpenAI 互換 base)</label>
                <input className="ai-input" value={form.baseUrl} onChange={(ev) => setForm((f) => ({ ...f, baseUrl: ev.target.value }))} placeholder="http://100.81.60.55:8000/v1" />
              </div>
            )}
            {formErr && <div className="ai-warning">{formErr}</div>}
            <div className="ai-test-row">
              <button type="button" className="todo-add-btn" onClick={() => void submitForm()}>{editId ? "更新" : "追加"}</button>
              <button type="button" className="ai-edit-btn" onClick={() => { setAdding(false); setEditId(null); setFormErr(null); }}>キャンセル</button>
            </div>
          </div>
        ) : (
          <button type="button" className="ai-edit-btn" onClick={() => { setAdding(true); setEditId(null); setForm({ label: "", provider: "anthropic", modelId: "", baseUrl: "" }); }}>
            + モデル追加
          </button>
        )}
      </section>

      {/* === tier 割当 === */}
      {tiers && (
        <section className="ai-card">
          <h3 className="ai-card-title">モデル割当 (3 段)</h3>
          <p className="ai-card-note">
            メイン / ヘビー は tool 対応が確認できたモデルのみ選べます (未テストは選択不可)。
            fallback は主モデルが落ちた時の切替先です。
          </p>
          {TIER_META.map((tm) => (
            <div className="ai-field" key={tm.key}>
              <label className="ai-label">{tm.label} — {tm.hint}</label>
              <div className="ai-input-row">
                <select className="ai-input" value={tiers.assignment[tm.key] ?? ""} onChange={(e) => setAssign(tm.key, "assignment", e.target.value)}>
                  <option value="">(未割当)</option>
                  {tierOptions(tm.toolRequired)}
                </select>
                <select className="ai-input" value={tiers.fallback[tm.key] ?? ""} onChange={(e) => setAssign(tm.key, "fallback", e.target.value)} title="fallback">
                  <option value="">fallback なし</option>
                  {tierOptions(tm.toolRequired)}
                </select>
              </div>
            </div>
          ))}

          {/* role 別上書き */}
          <button type="button" className="ai-edit-btn" onClick={() => setShowRoles((v) => !v)}>
            <IconChevron open={showRoles} />{showRoles ? "役割ごとの上書きを隠す" : "役割ごとの上書き (詳細)"}
          </button>
          {showRoles && (
            <div className="ai-role-overrides">
              <p className="ai-hint">役割ごとに既定 tier ではなく特定モデルを使わせます (例: 軽量処理をローカルに固定)。</p>
              {ROLE_META.map((rm) => {
                const cur = tiers.roleOverrides[rm.role] ?? "";
                const toolReq = rm.tier === "main" || rm.tier === "heavy";
                return (
                  <div className="ai-role-override" key={rm.role}>
                    <span className="ai-role-override-label">{rm.label}<span className="ai-role-override-tier"> (既定: {rm.tier})</span></span>
                    <select className="ai-input" value={cur} onChange={(e) => setRoleOverride(rm.role, e.target.value)}>
                      <option value="">既定 ({rm.tier})</option>
                      {entries.map((e) => {
                        const disabled = toolReq && e.capabilities.supportsTools !== true;
                        return <option key={e.id} value={e.id} disabled={disabled}>{e.label}{disabled ? disabledSuffix(e) : ""}</option>;
                      })}
                    </select>
                  </div>
                );
              })}
            </div>
          )}

          {tiersErr && <div className="ai-warning" style={{ whiteSpace: "pre-wrap" }}>{tiersErr}</div>}
          <div className="ai-test-row">
            {tiersMsg && <span className="ai-saved">{tiersMsg}</span>}
            <button type="button" className="todo-add-btn" onClick={() => void saveTiers()} disabled={savingTiers}>
              {savingTiers ? "保存中…" : "割当を保存"}
            </button>
          </div>
        </section>
      )}
    </>
  );
}
