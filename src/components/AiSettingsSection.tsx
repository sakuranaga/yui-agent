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
import ModelRegistryManager from "./ModelRegistryManager";

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
  }, []);

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
        モデルを登録 → 接続テストで tool 対応を確認 → メイン / サブ / ヘビー に割り当てます。
        API キーはマスク表示され、「編集」を押したときだけ書き換えられます。
      </p>

      {/* === 1. モデルレジストリ + 割当 (#206 M4) === */}
      <ModelRegistryManager />

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
