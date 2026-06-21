"use client";

/**
 * モデルレジストリ管理 UI (#206 M4)。
 *
 * - 登録モデル一覧: 能力バッジ (到達 / tool) + テスト / 編集 / 削除 / 追加
 * - tier 割当: main / sub / heavy / tool + fallback (main/heavy/tool は tool 対応モデルのみ選択可)
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
  toolUseRequiresThinking?: boolean;
};

type ThinkingMode = "auto" | "on" | "off";

type ModelEntry = {
  id: string;
  label: string;
  provider: Provider;
  modelId: string;
  baseUrl: string | null;
  apiKeyRef: string | null;
  capabilities: Capabilities;
  thinkingMode: ThinkingMode;
  maxTokens: number;
};

type TierName = "main" | "sub" | "heavy" | "tool";
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
  { key: "tool", label: "ツール選択", hint: "Executor #2 のツール選択専用 (xLAM 等の function-calling モデル)", toolRequired: true },
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
  { role: "intent", label: "ツール間変換", tier: "sub" },
  { role: "project_suggest", label: "プロジェクト提案", tier: "sub" },
  { role: "tool_gate", label: "ツール要否判定", tier: "tool" },
  { role: "executor", label: "ツール選択 (#2 Executor)", tier: "tool" },
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
  const [form, setForm] = useState<{ label: string; provider: Provider; modelId: string; baseUrl: string; maxTokens: string }>({
    label: "", provider: "anthropic", modelId: "", baseUrl: "", maxTokens: "8192",
  });
  const [editId, setEditId] = useState<string | null>(null);
  const [formErr, setFormErr] = useState<string | null>(null);
  // provider 別の利用可能モデル一覧 (hosted のみ。modelId を select させる)
  const [availModels, setAvailModels] = useState<Array<{ id: string; provider: string; label: string }>>([]);
  const [manualModel, setManualModel] = useState(false); // 一覧に無いモデルを手入力する

  const load = async () => {
    // setLoading(true) は付けない (= 初期値 true + reload 時のちらつき防止 + effect 内同期 setState 回避)
    try {
      const [er, tr, mr] = await Promise.all([
        fetch("/api/model-registry", { cache: "no-store" }),
        fetch("/api/model-registry/tiers", { cache: "no-store" }),
        fetch("/api/ai-settings/models", { cache: "no-store" }),
      ]);
      if (er.ok) setEntries(((await er.json()) as { entries: ModelEntry[] }).entries);
      if (tr.ok) setTiers((await tr.json()) as Tiers);
      if (mr.ok) setAvailModels(((await mr.json()) as { models: Array<{ id: string; provider: string; label: string }> }).models);
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

  // API キーを同画面で保存した直後などに、hosted モデル一覧を再取得する。
  const refreshModels = async () => {
    try {
      const mr = await fetch("/api/ai-settings/models?refresh=1", { cache: "no-store" });
      if (mr.ok) setAvailModels(((await mr.json()) as { models: Array<{ id: string; provider: string; label: string }> }).models);
    } catch (e) {
      console.warn("[model-registry] refreshModels failed:", e);
    }
  };

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

  const setThinkingMode = async (id: string, mode: ThinkingMode) => {
    // 楽観更新 + PATCH。失敗時は load() で戻す。
    setEntries((es) => es.map((e) => (e.id === id ? { ...e, thinkingMode: mode } : e)));
    try {
      const res = await fetch(`/api/model-registry/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ thinkingMode: mode }),
      });
      if (!res.ok) await load();
    } catch (e) {
      console.warn("[model-registry] thinkingMode update failed:", e);
      await load();
    }
  };

  const submitForm = async () => {
    setFormErr(null);
    // 正の整数のみ (parseInt は "1.5"→1 / "12a"→12 と丸めるので文字列で厳密判定)
    const mtStr = form.maxTokens.trim();
    if (!/^[1-9]\d*$/.test(mtStr) || Number(mtStr) > 1048576) {
      setFormErr("最大トークンは 1〜1048576 の整数で入力してください");
      return;
    }
    const mt = Number(mtStr);
    const payload = {
      label: form.label.trim(),
      provider: form.provider,
      modelId: form.modelId.trim(),
      maxTokens: mt,
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
        setForm({ label: "", provider: "anthropic", modelId: "", baseUrl: "", maxTokens: "8192" });
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
    setManualModel(true); // 編集は現在の modelId をそのまま見せる (テキスト入力)
    setForm({ label: e.label, provider: e.provider, modelId: e.modelId, baseUrl: e.baseUrl ?? "", maxTokens: String(e.maxTokens) });
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
          「テスト」で到達性と tool 対応を確認すると、メイン / ヘビー / ツール選択 枠に割り当てられるようになります。
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
                {e.provider === "local_openai" && (
                  <div className="ai-thinking-row">
                    <span className="ai-thinking-label">思考</span>
                    <select className="ai-input ai-thinking-select" value={e.thinkingMode} onChange={(ev) => void setThinkingMode(e.id, ev.target.value as ThinkingMode)}>
                      <option value="auto">自動 (tier 既定)</option>
                      <option value="on">ON (常時思考)</option>
                      <option value="off">OFF (速度優先)</option>
                    </select>
                    {e.thinkingMode === "off" && e.capabilities.toolUseRequiresThinking && (
                      <span className="ai-cap-err">このモデルは思考 ON でないと tool を使えません</span>
                    )}
                  </div>
                )}
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
                onChange={(ev) => { setManualModel(false); setForm((f) => ({ ...f, provider: ev.target.value as Provider, modelId: "" })); }}>
                {(Object.keys(PROVIDER_LABEL) as Provider[]).map((p) => (
                  <option key={p} value={p}>{PROVIDER_LABEL[p]}</option>
                ))}
              </select>
              {editId !== null && <div className="ai-hint">provider は変更できません (作り直してください)。</div>}
            </div>
            <div className="ai-field">
              <label className="ai-label">モデル ID</label>
              {(() => {
                const list = availModels.filter((m) => m.provider === form.provider);
                const useSelect = form.provider !== "local_openai" && list.length > 0 && !manualModel;
                if (useSelect) {
                  return (
                    <select
                      className="ai-input"
                      value={form.modelId}
                      onChange={(ev) => {
                        if (ev.target.value === "__manual__") { setManualModel(true); setForm((f) => ({ ...f, modelId: "" })); }
                        else setForm((f) => ({ ...f, modelId: ev.target.value }));
                      }}
                    >
                      <option value="">(モデルを選択)</option>
                      {list.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
                      <option value="__manual__">— その他 (手入力) —</option>
                    </select>
                  );
                }
                return (
                  <input className="ai-input" value={form.modelId}
                    onChange={(ev) => setForm((f) => ({ ...f, modelId: ev.target.value }))}
                    placeholder="例: claude-sonnet-4-6 / gemma-... " />
                );
              })()}
              {form.provider !== "local_openai" && (
                <div className="ai-test-row">
                  <button type="button" className="ai-test-btn" onClick={() => void refreshModels()}>モデル一覧を再取得</button>
                  {availModels.filter((m) => m.provider === form.provider).length === 0 && (
                    <span className="ai-hint">この provider の API キーが未登録か、取得に失敗 (手入力可)</span>
                  )}
                </div>
              )}
            </div>
            {form.provider === "local_openai" && (
              <div className="ai-field">
                <label className="ai-label">エンドポイント (OpenAI 互換 base)</label>
                <input className="ai-input" value={form.baseUrl} onChange={(ev) => setForm((f) => ({ ...f, baseUrl: ev.target.value }))} placeholder="http://100.81.60.55:8000/v1" />
              </div>
            )}
            <div className="ai-field">
              <label className="ai-label">最大トークン (出力上限)</label>
              <input className="ai-input ai-input-small" type="number" min={1} max={1048576} value={form.maxTokens}
                onChange={(ev) => setForm((f) => ({ ...f, maxTokens: ev.target.value }))} />
              <div className="ai-hint">
                {form.provider === "local_openai"
                  ? "思考モデルは思考+回答で大きめに (例 32768)。サーバの -c 以下に。"
                  : "hosted はモデルの非ストリーミング上限以下に (大きすぎると Anthropic は >10分 guard で失敗、OpenAI/Gemini は上限超過で 400)。既定 8192。"}
              </div>
            </div>
            {formErr && <div className="ai-warning">{formErr}</div>}
            <div className="ai-test-row">
              <button type="button" className="todo-add-btn" onClick={() => void submitForm()}>{editId ? "更新" : "追加"}</button>
              <button type="button" className="ai-edit-btn" onClick={() => { setAdding(false); setEditId(null); setFormErr(null); }}>キャンセル</button>
            </div>
          </div>
        ) : (
          <button type="button" className="ai-edit-btn" onClick={() => { setAdding(true); setEditId(null); setManualModel(false); setForm({ label: "", provider: "anthropic", modelId: "", baseUrl: "", maxTokens: "8192" }); }}>
            + モデル追加
          </button>
        )}
      </section>

      {/* === tier 割当 === */}
      {tiers && (
        <section className="ai-card">
          <h3 className="ai-card-title">モデル割当 (4 段)</h3>
          <p className="ai-card-note">
            メイン / ヘビー / ツール選択 は tool 対応が確認できたモデルのみ選べます (未テストは選択不可)。
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
                const toolReq = rm.tier === "main" || rm.tier === "heavy" || rm.tier === "tool";
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
