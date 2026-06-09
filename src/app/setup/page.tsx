"use client";

/**
 * /setup — 初回セットアップウィザード。
 *
 * 「最低限動くために要るもの」を 2 ステップで入力させる:
 *   Step 1: AI provider 選択 + API key
 *   Step 2: メイン / サブモデル + Embeddings
 *
 * 完了後 `/` に遷移。設定済みの状態でも自由に再アクセスして上書き可能
 * (= テスト & 設定変更用途、`/` 側の redirect は片道だけ、`/setup` からは弾かない)。
 *
 * その他 (Google / Spotify / Discord 等) は Settings タブで個別に連携する。
 */
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

type ProviderId = "anthropic" | "openai" | "gemini" | "grok";
type LlmModel = { id: string; provider: ProviderId; label: string };
type EmbedPreset = "ollama" | "openai" | "custom";

const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Anthropic Claude (推奨)",
  openai: "OpenAI",
  gemini: "Google Gemini",
  grok: "xAI Grok",
};

/** UI 上の provider → ai_settings 上の key 名のマッピング */
const PROVIDER_KEY_FIELD: Record<ProviderId, string> = {
  anthropic: "anthropic_api_key",
  openai: "openai_api_key",
  gemini: "gemini_api_key",
  grok: "grok_api_key",
};

const EMBED_PRESETS: Record<
  Exclude<EmbedPreset, "custom">,
  { url: string; model: string; dimensions: number }
> = {
  ollama: {
    url: "http://host.docker.internal:11434/v1/embeddings",
    model: "bge-m3",
    dimensions: 1024,
  },
  openai: {
    url: "https://api.openai.com/v1/embeddings",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
};

/** provider 毎に「これがメインっぽい」を推測する (= UI default 用、ユーザが変更可) */
function suggestMain(provider: ProviderId, models: LlmModel[]): string {
  const ids = models.map((m) => m.id);
  const preferences: Record<ProviderId, string[]> = {
    anthropic: ["claude-opus-4-7", "claude-sonnet-4-6", "claude-sonnet-4-5"],
    openai: ["gpt-5", "gpt-4o", "gpt-4-turbo"],
    gemini: ["gemini-2.5-pro", "gemini-2.0-pro", "gemini-1.5-pro"],
    grok: ["grok-3", "grok-2"],
  };
  for (const want of preferences[provider]) {
    const found = ids.find((id) => id === want || id.startsWith(want));
    if (found) return found;
  }
  return ids[0] ?? "";
}

function suggestSub(provider: ProviderId, models: LlmModel[]): string {
  const ids = models.map((m) => m.id);
  const preferences: Record<ProviderId, string[]> = {
    anthropic: ["claude-haiku-4-5", "claude-haiku-3-5"],
    openai: ["gpt-4o-mini", "gpt-4-mini"],
    gemini: ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-1.5-flash"],
    grok: ["grok-3-mini", "grok-2-mini"],
  };
  for (const want of preferences[provider]) {
    const found = ids.find((id) => id === want || id.startsWith(want));
    if (found) return found;
  }
  return ids[ids.length - 1] ?? "";
}

export default function SetupPage() {
  const router = useRouter();

  const [step, setStep] = useState<1 | 2>(1);

  // step 1
  const [provider, setProvider] = useState<ProviderId>("anthropic");
  const [apiKey, setApiKey] = useState("");

  // step 2
  const [models, setModels] = useState<LlmModel[]>([]);
  const [mainModel, setMainModel] = useState("");
  const [subModel, setSubModel] = useState("");

  const [embedPreset, setEmbedPreset] = useState<EmbedPreset>("ollama");
  const [embedUrl, setEmbedUrl] = useState(EMBED_PRESETS.ollama.url);
  const [embedModel, setEmbedModel] = useState(EMBED_PRESETS.ollama.model);
  const [embedDimensions, setEmbedDimensions] = useState(
    EMBED_PRESETS.ollama.dimensions.toString()
  );

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyConfigured, setAlreadyConfigured] = useState(false);

  // 既に設定済みかどうかを表示用に取得 (UX 補助、redirect はしない)
  useEffect(() => {
    void (async () => {
      try {
        const res = await fetch("/api/setup/status");
        if (!res.ok) return;
        const data = (await res.json()) as { configured: boolean };
        setAlreadyConfigured(data.configured);
      } catch {
        /* noop */
      }
    })();
  }, []);

  function pickPreset(preset: EmbedPreset) {
    setEmbedPreset(preset);
    if (preset === "custom") return;
    const p = EMBED_PRESETS[preset];
    setEmbedUrl(p.url);
    setEmbedModel(p.model);
    setEmbedDimensions(p.dimensions.toString());
  }

  async function submitStep1(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    if (apiKey.trim().length === 0) {
      setError("API key を入力してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      // 1) API key を保存
      const saveRes = await fetch("/api/ai-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [PROVIDER_KEY_FIELD[provider]]: apiKey.trim() }),
      });
      if (!saveRes.ok) {
        setError("API key の保存に失敗しました。");
        return;
      }
      // 2) 利用可能 model 一覧を取得 (cache invalidate + 取り直し)
      const modelsRes = await fetch("/api/ai-settings/models?refresh=1");
      if (!modelsRes.ok) {
        setError("モデル一覧の取得に失敗しました。サーバログを確認してください。");
        return;
      }
      const data = (await modelsRes.json()) as { models: LlmModel[] };
      const providerModels = data.models.filter((m) => m.provider === provider);
      if (providerModels.length === 0) {
        setError(
          "利用可能なモデルが見つかりません。API key が無効、または provider 側の障害の可能性があります。"
        );
        return;
      }
      setModels(providerModels);
      setMainModel(suggestMain(provider, providerModels));
      setSubModel(suggestSub(provider, providerModels));
      setStep(2);
    } catch {
      setError("通信エラーが発生しました。");
    } finally {
      setBusy(false);
    }
  }

  async function submitStep2(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    const dim = parseInt(embedDimensions, 10);
    if (!Number.isFinite(dim) || dim <= 0) {
      setError("Embedding dimensions は正の整数を入力してください。");
      return;
    }
    if (embedUrl.trim().length === 0 || embedModel.trim().length === 0) {
      setError("Embeddings URL と model 名は必須です。");
      return;
    }
    if (mainModel.length === 0 || subModel.length === 0) {
      setError("メインモデルとサブモデルを選択してください。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anthropic_main_model: mainModel,
          anthropic_haiku_model: subModel,
          embed_url: embedUrl.trim(),
          embed_model: embedModel.trim(),
          embed_dimensions: String(dim),
        }),
      });
      if (!res.ok) {
        setError("設定の保存に失敗しました。");
        return;
      }
      router.replace("/");
    } catch {
      setError("通信エラーが発生しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0f0f12",
        color: "#eee",
        fontFamily: "system-ui, sans-serif",
        padding: "2rem",
      }}
    >
      <div
        style={{
          background: "#18181d",
          padding: "2rem",
          borderRadius: "12px",
          width: "100%",
          maxWidth: "36rem",
          boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
        }}
      >
        <h1
          style={{
            margin: "0 0 0.4rem 0",
            fontSize: "1.5rem",
            letterSpacing: "0.02em",
          }}
        >
          Yui Agent — 初期セットアップ
        </h1>
        <p
          style={{
            margin: "0 0 1.2rem 0",
            color: "#999",
            fontSize: "0.85rem",
          }}
        >
          ステップ {step} / 2
          {alreadyConfigured ? "  (= 上書き再設定中)" : ""}
          。Google / Spotify / Discord 等の連携は完了後に
          <code style={{ color: "#f48fb1" }}>設定 &gt; 連携</code> から追加できます。
        </p>

        {step === 1 && (
          <form onSubmit={submitStep1}>
            <Label>AI provider</Label>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as ProviderId)}
              style={inputStyle}
            >
              {(["anthropic", "openai", "gemini", "grok"] as ProviderId[]).map(
                (p) => (
                  <option key={p} value={p}>
                    {PROVIDER_LABELS[p]}
                  </option>
                )
              )}
            </select>

            <Label>{PROVIDER_LABELS[provider]} の API key</Label>
            <input
              name="setup-api-key"
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              autoComplete="new-password"
              spellCheck={false}
              placeholder={
                provider === "anthropic"
                  ? "sk-ant-..."
                  : provider === "openai"
                    ? "sk-..."
                    : provider === "grok"
                      ? "xai-..."
                      : "API key"
              }
              style={{ ...inputStyle, fontFamily: "ui-monospace, monospace" }}
            />
            <p
              style={{
                margin: "0.4rem 0 0 0",
                fontSize: "0.75rem",
                color: "#888",
              }}
            >
              入力後、保存されたキーを使って自動でモデル一覧を取得します。
            </p>

            {error && <ErrorLine>{error}</ErrorLine>}

            <button
              type="submit"
              disabled={busy || apiKey.trim().length === 0}
              style={primaryButtonStyle(busy || apiKey.trim().length === 0)}
            >
              {busy ? "保存中…" : "次へ (キー保存 → モデル取得)"}
            </button>
          </form>
        )}

        {step === 2 && (
          <form onSubmit={submitStep2}>
            <Label>メインモデル (= Yui 本体の応答に使う)</Label>
            <select
              value={mainModel}
              onChange={(e) => setMainModel(e.target.value)}
              style={inputStyle}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>

            <Label>サブモデル (= 抽出 / 分類 / 要約用、軽量)</Label>
            <select
              value={subModel}
              onChange={(e) => setSubModel(e.target.value)}
              style={inputStyle}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>

            <div
              style={{
                marginTop: "1.2rem",
                paddingTop: "1.2rem",
                borderTop: "1px solid #2a2a30",
              }}
            >
              <Label>Embeddings (= memory 機能の前提)</Label>
              <div style={{ display: "flex", gap: "0.5rem", marginBottom: "0.7rem" }}>
                {(["ollama", "openai", "custom"] as EmbedPreset[]).map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => pickPreset(p)}
                    style={{
                      flex: 1,
                      padding: "0.5rem",
                      background: embedPreset === p ? "#2a2a35" : "#222",
                      border:
                        embedPreset === p
                          ? "1px solid #ec407a"
                          : "1px solid #333",
                      borderRadius: "6px",
                      color: "#eee",
                      cursor: "pointer",
                      fontSize: "0.85rem",
                    }}
                  >
                    {p === "ollama" ? "Ollama" : p === "openai" ? "OpenAI" : "Custom"}
                  </button>
                ))}
              </div>

              <SubLabel>URL</SubLabel>
              <input
                name="setup-embed-url"
                type="text"
                value={embedUrl}
                onChange={(e) => {
                  setEmbedUrl(e.target.value);
                  setEmbedPreset("custom");
                }}
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: "ui-monospace, monospace" }}
              />

              <SubLabel>モデル名</SubLabel>
              <input
                name="setup-embed-model"
                type="text"
                value={embedModel}
                onChange={(e) => {
                  setEmbedModel(e.target.value);
                  setEmbedPreset("custom");
                }}
                spellCheck={false}
                style={{ ...inputStyle, fontFamily: "ui-monospace, monospace" }}
              />

              <SubLabel>次元数</SubLabel>
              <input
                name="setup-embed-dimensions"
                type="number"
                value={embedDimensions}
                onChange={(e) => {
                  setEmbedDimensions(e.target.value);
                  setEmbedPreset("custom");
                }}
                min={1}
                style={inputStyle}
              />
            </div>

            {error && <ErrorLine>{error}</ErrorLine>}

            <div style={{ display: "flex", gap: "0.7rem", marginTop: "1.2rem" }}>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setStep(1);
                }}
                disabled={busy}
                style={{
                  ...secondaryButtonStyle,
                  flex: "0 0 auto",
                  opacity: busy ? 0.5 : 1,
                  cursor: busy ? "not-allowed" : "pointer",
                }}
              >
                戻る
              </button>
              <button
                type="submit"
                disabled={busy}
                style={{ ...primaryButtonStyle(busy), flex: 1 }}
              >
                {busy ? "保存中…" : "セットアップ完了"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: "0.85rem",
        color: "#bbb",
        marginTop: "1rem",
        marginBottom: "0.4rem",
      }}
    >
      {children}
    </label>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <label
      style={{
        display: "block",
        fontSize: "0.75rem",
        color: "#999",
        marginTop: "0.7rem",
        marginBottom: "0.3rem",
      }}
    >
      {children}
    </label>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p
      style={{
        margin: "0.8rem 0 0 0",
        color: "#ff8a80",
        fontSize: "0.85rem",
      }}
    >
      {children}
    </p>
  );
}

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "0.6rem 0.8rem",
  background: "#222",
  border: "1px solid #333",
  borderRadius: "8px",
  color: "#fff",
  fontSize: "0.95rem",
  boxSizing: "border-box",
};

function primaryButtonStyle(disabled: boolean): React.CSSProperties {
  return {
    marginTop: "1.2rem",
    width: "100%",
    padding: "0.7rem",
    background: disabled
      ? "#444"
      : "linear-gradient(135deg, #ec407a, #ad1457)",
    color: "#fff",
    border: "none",
    borderRadius: "8px",
    fontSize: "1rem",
    cursor: disabled ? "not-allowed" : "pointer",
    fontWeight: 600,
  };
}

const secondaryButtonStyle: React.CSSProperties = {
  padding: "0.7rem 1.2rem",
  background: "#2a2a30",
  color: "#eee",
  border: "1px solid #333",
  borderRadius: "8px",
  fontSize: "0.95rem",
  fontWeight: 500,
};
