"use client";

/**
 * AI 関連設定 (SettingsModal「AI」タブ)。
 *
 * カード構造:
 *   1. モデル選択         メイン / サブを全 provider の中から選択
 *   2. API キー           Anthropic / OpenAI / Gemini / Grok
 *   3. ローカル LLM       Gemma 等の OpenAI 互換ローカル
 *   4. TTS
 *   5. Embeddings
 *
 * 設計: docs/ai-settings.md §6
 */
import { useEffect, useState } from "react";

type Settings = {
  anthropic_api_key: string;
  anthropic_main_model: string;   // legacy 命名: 実際は「メインモデル」(任意 provider)
  anthropic_haiku_model: string;  // legacy 命名: 実際は「サブモデル」(任意 provider)
  openai_api_key: string;
  gemini_api_key: string;
  grok_api_key: string;
  local_llm_enabled: string;
  local_llm_url: string;
  local_llm_model: string;
  local_llm_roles: string;
  tts_url: string;
  tts_normal_ref: string;
  tts_whisper_ref: string;
  embed_url: string;
  embed_model: string;
  embed_dimensions: string;
};

type ProviderId = "anthropic" | "openai" | "gemini" | "grok";

type LlmModel = {
  id: string;
  provider: ProviderId;
  label: string;
};

type ModelListResponse = {
  models: LlmModel[];
  providers: Record<ProviderId, { hasKey: boolean; modelCount: number }>;
};

const PROVIDER_LABEL: Record<ProviderId, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  grok: "Grok",
};

const API_KEY_FIELDS: Array<{
  key: keyof Settings & `${ProviderId}_api_key`;
  provider: ProviderId;
  placeholder: string;
}> = [
  { key: "anthropic_api_key", provider: "anthropic", placeholder: "sk-ant-..." },
  { key: "openai_api_key",    provider: "openai",    placeholder: "sk-..." },
  { key: "gemini_api_key",    provider: "gemini",    placeholder: "AIza..." },
  { key: "grok_api_key",      provider: "grok",      placeholder: "xai-..." },
];

const LOCAL_ROLE_OPTIONS: Array<{ key: string; label: string; desc: string }> = [
  { key: "extract",       label: "会話 → 記憶抽出",       desc: "プライバシー大: 会話本文を外部に送らない" },
  { key: "reconcile",     label: "記憶の矛盾 / 重複解消", desc: "プライバシー大: 記憶内容を外部に送らない" },
  { key: "judge",         label: "ディスパッチ判定",       desc: "二値判定、頻度高い軽量タスク" },
  { key: "tts_normalize", label: "TTS 前処理 (読み正規化)", desc: "発話毎に走る、規則的なタスク" },
  { key: "mail_curate",   label: "メール仕分け",           desc: "プライバシー大 + コスト 0: メール本文を外部に送らない、1日数百件処理" },
  { key: "food_extract",  label: "食事ログ抽出",           desc: "プライバシー大: 食事/体重情報を外部に送らない。会話毎に走るので頻度高め" },
];

type TestProvider = "anthropic" | "local" | "tts" | "embed";

type TestResult = {
  ok: boolean;
  latencyMs?: number;
  error?: string;
};

export default function AiSettingsSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [editKeys, setEditKeys] = useState<Record<ProviderId, boolean>>({
    anthropic: false, openai: false, gemini: false, grok: false,
  });
  const [testing, setTesting] = useState<TestProvider | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<TestProvider, TestResult>>>({});

  // モデル一覧 (起動時に取得 + API キー保存後に refresh)
  const [models, setModels] = useState<LlmModel[]>([]);
  const [providerStatus, setProviderStatus] =
    useState<ModelListResponse["providers"] | null>(null);
  const [modelsLoading, setModelsLoading] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("/api/ai-settings", { cache: "no-store" });
        if (!res.ok) return;
        const data = (await res.json()) as { settings: Settings };
        setSettings(data.settings);
        setDraft(data.settings);
      } catch (e) {
        console.warn("[ai-settings] load failed:", e);
      } finally {
        setLoading(false);
      }
    })();
    void loadModels(false);
  }, []);

  const loadModels = async (refresh: boolean) => {
    setModelsLoading(true);
    try {
      const url = refresh ? "/api/ai-settings/models?refresh=1" : "/api/ai-settings/models";
      const res = await fetch(url, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as ModelListResponse;
      setModels(data.models);
      setProviderStatus(data.providers);
    } catch (e) {
      console.warn("[ai-settings] models load failed:", e);
    } finally {
      setModelsLoading(false);
    }
  };

  const update = (key: keyof Settings, value: string) => {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const payload: Partial<Settings> = { ...draft };
      // 編集していない API キーはマスク値を送らない (server で skip されるが念のため)
      for (const f of API_KEY_FIELDS) {
        if (!editKeys[f.provider]) delete payload[f.key];
      }
      const res = await fetch("/api/ai-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        setSavedAt(Date.now());
        setEditKeys({ anthropic: false, openai: false, gemini: false, grok: false });
        const refresh = await fetch("/api/ai-settings", { cache: "no-store" });
        const data = (await refresh.json()) as { settings: Settings };
        setSettings(data.settings);
        setDraft(data.settings);
        // API キーが変わった可能性があるので model 一覧も refresh
        void loadModels(true);
        // TTS 設定が変わった可能性 → IconBar 等で使う TTS status キャッシュをクリア
        // + custom event で IconBar に再 ping を促す (= 即時 SLEEP ボタン更新)
        try {
          window.localStorage.removeItem("vroid-tts-status");
          window.dispatchEvent(new CustomEvent("yui-tts-status-recheck"));
        } catch {
          /* noop */
        }
      }
    } catch (e) {
      console.warn("[ai-settings] save failed:", e);
    } finally {
      setSaving(false);
    }
  };

  const test = async (provider: TestProvider) => {
    if (!draft) return;
    setTesting(provider);
    setTestResults((r) => ({ ...r, [provider]: undefined }));
    try {
      const res = await fetch(`/api/ai-settings/test/${provider}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      const data = (await res.json()) as TestResult;
      setTestResults((r) => ({ ...r, [provider]: data }));
      // TTS テスト結果は IconBar 等で使う status キャッシュにも反映 (= SLEEP ボタン即時更新)
      if (provider === "tts") {
        try {
          window.localStorage.setItem(
            "vroid-tts-status",
            JSON.stringify({ ok: !!data.ok, ts: Date.now() })
          );
          window.dispatchEvent(
            new CustomEvent("yui-tts-status-change", { detail: { ok: !!data.ok } })
          );
        } catch {
          /* noop */
        }
      }
    } catch (e) {
      setTestResults((r) => ({
        ...r,
        [provider]: { ok: false, error: e instanceof Error ? e.message : String(e) },
      }));
    } finally {
      setTesting(null);
    }
  };

  if (loading || !draft || !settings) {
    return <div className="settings-placeholder">読み込み中…</div>;
  }

  const dirty =
    JSON.stringify(draft) !== JSON.stringify(settings) ||
    Object.values(editKeys).some(Boolean);

  return (
    <div className="ai-settings">
      <p className="ai-settings-desc">
        メイン / サブモデルは登録済み API キーの provider すべてから選択できます。
        API キーはマスク表示され、「編集」を押したときだけ書き換えられます。
      </p>

      {/* === 1. モデル選択 === */}
      <section className="ai-card">
        <h3 className="ai-card-title">モデル選択</h3>
        <ModelSelect
          label="メインモデル"
          hint="Yui 本体の応答に使うモデル"
          value={draft.anthropic_main_model}
          onChange={(v) => update("anthropic_main_model", v)}
          models={models}
          loading={modelsLoading}
        />
        <ModelSelect
          label="サブモデル"
          hint="要約・分類など軽量タスク用"
          value={draft.anthropic_haiku_model}
          onChange={(v) => update("anthropic_haiku_model", v)}
          models={models}
          loading={modelsLoading}
        />
        <div className="ai-test-row">
          <button
            type="button"
            className="ai-test-btn"
            onClick={() => void loadModels(true)}
            disabled={modelsLoading}
          >
            {modelsLoading ? "取得中…" : "モデル一覧を再取得"}
          </button>
          {providerStatus && (
            <span className="ai-test-result">
              {(["anthropic", "openai", "gemini", "grok"] as ProviderId[])
                .filter((p) => providerStatus[p].hasKey)
                .map((p) => `${PROVIDER_LABEL[p]} ${providerStatus[p].modelCount}`)
                .join(" / ") || "API キー未登録"}
            </span>
          )}
        </div>
      </section>

      {/* === 2. API キー === */}
      <section className="ai-card">
        <h3 className="ai-card-title">API キー</h3>
        {API_KEY_FIELDS.map((f) => (
          <div className="ai-field" key={f.key}>
            <label className="ai-label">{PROVIDER_LABEL[f.provider]}</label>
            <div className="ai-input-row">
              <input
                name={`ai-settings-${f.key}`}
                type={editKeys[f.provider] ? "text" : "password"}
                className="ai-input"
                value={draft[f.key]}
                onChange={(e) => update(f.key, e.target.value)}
                placeholder={f.placeholder}
                disabled={!editKeys[f.provider]}
              />
              <button
                type="button"
                className="ai-edit-btn"
                onClick={() => {
                  if (editKeys[f.provider]) {
                    // キャンセル: 元の値に戻す
                    update(f.key, settings[f.key]);
                  }
                  setEditKeys((s) => ({ ...s, [f.provider]: !s[f.provider] }));
                }}
              >
                {editKeys[f.provider] ? "キャンセル" : "編集"}
              </button>
            </div>
          </div>
        ))}
        <TestRow
          provider="anthropic"
          label="Anthropic 接続テスト"
          result={testResults.anthropic}
          testing={testing === "anthropic"}
          onTest={() => void test("anthropic")}
        />
        <div className="ai-hint">
          ※ OpenAI / Gemini / Grok の実呼び出しは Phase 2 で実装予定。
          現状は model 一覧の取得のみ各 provider から行います。
        </div>
      </section>

      {/* === 3. ローカル LLM === */}
      <section className="ai-card">
        <h3 className="ai-card-title">ローカル LLM</h3>
        <div className="ai-field ai-field-checkbox">
          <label className="ai-checkbox-label">
            <input
              type="checkbox"
              checked={draft.local_llm_enabled === "true"}
              onChange={(e) => update("local_llm_enabled", e.target.checked ? "true" : "false")}
            />
            <span>有効</span>
          </label>
          <span className="ai-hint">
            メール仕分け等のローカル処理に使用 (例: Gemma on AI Max+ 395)
          </span>
        </div>
        <div className="ai-field">
          <label className="ai-label">エンドポイント (OpenAI 互換)</label>
          <input
            name="ai-settings-local-llm-url"
            type="text"
            className="ai-input"
            value={draft.local_llm_url}
            onChange={(e) => update("local_llm_url", e.target.value)}
            placeholder="http://llm:8081/v1/chat/completions"
          />
        </div>
        <div className="ai-field">
          <label className="ai-label">モデル名</label>
          <input
            name="ai-settings-local-llm-model"
            type="text"
            className="ai-input"
            value={draft.local_llm_model}
            onChange={(e) => update("local_llm_model", e.target.value)}
            placeholder="gemma-4-26b-a4b"
          />
        </div>

        <div className="ai-field">
          <label className="ai-label">ローカル LLM で処理する役割</label>
          <div className="ai-hint">
            チェックを入れた処理は Anthropic ではなくローカル LLM が担当します。
          </div>
          <div className="ai-role-list">
            {LOCAL_ROLE_OPTIONS.map((opt) => {
              const enabled = roleListHas(draft.local_llm_roles, opt.key);
              return (
                <label key={opt.key} className="ai-role-item">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(e) =>
                      update(
                        "local_llm_roles",
                        toggleRole(draft.local_llm_roles, opt.key, e.target.checked)
                      )
                    }
                  />
                  <div className="ai-role-text">
                    <div className="ai-role-label">{opt.label}</div>
                    <div className="ai-role-desc">{opt.desc}</div>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        <TestRow
          provider="local"
          result={testResults.local}
          testing={testing === "local"}
          onTest={() => void test("local")}
        />
      </section>

      {/* === 4. TTS === */}
      <section className="ai-card">
        <h3 className="ai-card-title">TTS</h3>
        <p className="ai-card-note">
          結衣の音声合成 (任意)。空欄なら音声なしでチャットは動作、SLEEP 機能は無効化されます。
        </p>
        <div className="ai-field">
          <label className="ai-label">サーバー URL</label>
          <input
            name="ai-settings-tts-url"
            type="text"
            className="ai-input"
            value={draft.tts_url}
            onChange={(e) => update("tts_url", e.target.value)}
            placeholder="http://localhost:7880  (空欄で TTS 無効)"
          />
        </div>
        <TestRow
          provider="tts"
          result={testResults.tts}
          testing={testing === "tts"}
          onTest={() => void test("tts")}
        />

        <p className="ai-card-note" style={{ marginTop: 12 }}>
          <strong>Reference 音声 (任意)</strong> — TTS server 側に置いた wav ファイルの
          絶対パス。サーバが <code>soundfile.open(ref_wav)</code> で読むので「TTS server
          から見える絶対パス」を指定。リポジトリの <code>assets/tts-refs/</code> に同梱した
          サンプルファイルを TTS server にコピーして、そのパスを入力してください。空欄なら
          TTS server の default voice 使用。
        </p>
        <div className="ai-field">
          <label className="ai-label">通常 voice ref (cool_seed_7777.wav 等)</label>
          <input
            name="ai-settings-tts-normal-ref"
            type="text"
            className="ai-input"
            value={draft.tts_normal_ref}
            onChange={(e) => update("tts_normal_ref", e.target.value)}
            placeholder="/path/to/cool_seed_7777.wav  (空欄で default voice)"
          />
        </div>
        <div className="ai-field">
          <label className="ai-label">睡眠囁き ref (whisper_ref.wav)</label>
          <input
            name="ai-settings-tts-whisper-ref"
            type="text"
            className="ai-input"
            value={draft.tts_whisper_ref}
            onChange={(e) => update("tts_whisper_ref", e.target.value)}
            placeholder="/path/to/whisper_ref.wav  (空欄で囁きなし)"
          />
        </div>
      </section>

      {/* === 5. Embeddings === */}
      <section className="ai-card">
        <h3 className="ai-card-title">Embeddings</h3>
        <p className="ai-card-note">
          memory システム (記憶・検索・関連付け) に必須。空欄だと memory 機能が無効化されます。
          <br />
          推奨: Ollama (= ローカル無料、要 install) または OpenAI 互換 API。
          OpenAI 直なら <code>https://api.openai.com/v1/embeddings</code> + <code>text-embedding-3-small</code> (次元数 1536)。
          Ollama なら <code>http://host.docker.internal:11434/v1/embeddings</code> + <code>bge-m3</code> (次元数 1024)。
        </p>
        <div className="ai-field">
          <label className="ai-label">エンドポイント</label>
          <input
            name="ai-settings-embed-url"
            type="text"
            className="ai-input"
            value={draft.embed_url}
            onChange={(e) => update("embed_url", e.target.value)}
            placeholder="http://host.docker.internal:11434/v1/embeddings  (空欄で memory 無効)"
          />
        </div>
        <div className="ai-field">
          <label className="ai-label">モデル名</label>
          <input
            name="ai-settings-embed-model"
            type="text"
            className="ai-input"
            value={draft.embed_model}
            onChange={(e) => update("embed_model", e.target.value)}
            placeholder="bge-m3"
          />
        </div>
        <div className="ai-field">
          <label className="ai-label">次元数</label>
          <input
            name="ai-settings-embed-dimensions"
            type="number"
            className="ai-input ai-input-small"
            value={draft.embed_dimensions}
            onChange={(e) => update("embed_dimensions", e.target.value)}
            min={64}
            max={8192}
          />
          {draft.embed_dimensions !== settings.embed_dimensions && (
            <div className="ai-warning">
              次元数を変更すると既存の vector と互換性が壊れます。memory の rebuild が必要です。
            </div>
          )}
        </div>
        <TestRow
          provider="embed"
          result={testResults.embed}
          testing={testing === "embed"}
          onTest={() => void test("embed")}
        />
      </section>

      <div className="ai-foot">
        {savedAt && Date.now() - savedAt < 2500 && (
          <span className="ai-saved">保存しました</span>
        )}
        <button
          type="button"
          className="todo-add-btn"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? "保存中…" : "保存"}
        </button>
      </div>
    </div>
  );
}

function ModelSelect(props: {
  label: string;
  hint?: string;
  value: string;
  onChange: (v: string) => void;
  models: LlmModel[];
  loading: boolean;
}) {
  const grouped: Record<ProviderId, LlmModel[]> = {
    anthropic: [], openai: [], gemini: [], grok: [],
  };
  for (const m of props.models) grouped[m.provider].push(m);

  // 現在保存値が一覧に無ければ "現在の保存値" として末尾に option を追加
  const currentInList = props.models.some((m) => m.id === props.value);
  const showCurrentFallback = props.value.length > 0 && !currentInList;

  return (
    <div className="ai-field">
      <label className="ai-label">{props.label}</label>
      <select
        className="ai-input"
        value={props.value}
        onChange={(e) => props.onChange(e.target.value)}
        disabled={props.loading}
      >
        <option value="">(未選択)</option>
        {(["anthropic", "openai", "gemini", "grok"] as ProviderId[]).map((p) =>
          grouped[p].length === 0 ? null : (
            <optgroup key={p} label={PROVIDER_LABEL[p]}>
              {grouped[p].map((m) => (
                <option key={`${p}:${m.id}`} value={m.id}>
                  {m.label}
                </option>
              ))}
            </optgroup>
          )
        )}
        {showCurrentFallback && (
          <optgroup label="現在の保存値 (取得できず)">
            <option value={props.value}>{props.value}</option>
          </optgroup>
        )}
      </select>
      {props.hint && <div className="ai-hint">{props.hint}</div>}
    </div>
  );
}

function roleListHas(csv: string, key: string): boolean {
  return csv.split(",").map((s) => s.trim()).includes(key);
}

function toggleRole(csv: string, key: string, enable: boolean): string {
  const set = new Set(
    csv.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
  );
  if (enable) set.add(key);
  else set.delete(key);
  return Array.from(set).join(",");
}

function TestRow(props: {
  provider: TestProvider;
  label?: string;
  result?: TestResult;
  testing: boolean;
  onTest: () => void;
}) {
  return (
    <div className="ai-test-row">
      <button
        type="button"
        className="ai-test-btn"
        onClick={props.onTest}
        disabled={props.testing}
      >
        {props.testing ? "テスト中…" : (props.label ?? "接続テスト")}
      </button>
      {props.result && (
        <span className={`ai-test-result ${props.result.ok ? "ok" : "err"}`}>
          {props.result.ok
            ? `応答 ok (${props.result.latencyMs}ms)`
            : (props.result.error ?? "失敗")}
        </span>
      )}
    </div>
  );
}
