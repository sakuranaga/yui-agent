"use client";

/**
 * Google (Calendar / Gmail readonly) 連携セクション。
 * SettingsPanel (/settings standalone page) と SettingsModal の両方で使う。
 *
 * - OAuth は popup window で開いて、callback 完了で window.close + postMessage
 *   → このセクションが message を受けて再 fetch
 */
import { useCallback, useEffect, useState } from "react";

type Status =
  | { loading: true }
  | { loading: false; connected: false; clientConfigured: boolean; error?: string }
  | {
      loading: false;
      connected: true;
      clientConfigured: true;
      email: string;
      scopes: string[];
      connectedAt: string;
    };

type Props = {
  initialFlash?: { kind: "ok" | "err"; text: string } | null;
};

export default function GoogleIntegrationSection({ initialFlash = null }: Props) {
  const [status, setStatus] = useState<Status>({ loading: true });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(
    initialFlash
  );

  const reload = useCallback(async () => {
    setStatus({ loading: true });
    try {
      const res = await fetch("/api/settings/google-status", { cache: "no-store" });
      const data = await res.json();
      setStatus({ loading: false, ...data });
    } catch (e) {
      setStatus({
        loading: false,
        connected: false,
        clientConfigured: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  useEffect(() => {
    // 初回 mount + reload 変化時に Google 連携状態を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reload();
  }, [reload]);

  useEffect(() => {
    function onMessage(ev: MessageEvent) {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { type?: string; email?: string; error?: string };
      if (data?.type === "google-oauth-success") {
        setFlash({
          kind: "ok",
          text: `${data.email ?? ""} を連携しました`.trim(),
        });
        void reload();
      } else if (data?.type === "google-oauth-error") {
        setFlash({ kind: "err", text: data.error ?? "OAuth エラー" });
        void reload();
      }
    }
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [reload]);

  function openConnectPopup() {
    const w = 520;
    const h = 720;
    const left = Math.max(0, (window.screen.width - w) / 2);
    const top = Math.max(0, (window.screen.height - h) / 2);
    const popup = window.open(
      "/api/auth/google/start?popup=1",
      "yui-google-oauth",
      `width=${w},height=${h},left=${left},top=${top},menubar=no,toolbar=no,location=no,status=no`
    );
    if (!popup) {
      setFlash({
        kind: "err",
        text: "ポップアップがブロックされました。許可してから再試行してください。",
      });
    }
  }

  async function disconnect() {
    if (!confirm("Google 連携を解除しますか?")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/auth/google/disconnect", { method: "POST" });
      const data = await res.json();
      if (!data.ok) throw new Error(data.error ?? "disconnect failed");
      setFlash({ kind: "ok", text: "連携を解除しました" });
      await reload();
    } catch (e) {
      setFlash({
        kind: "err",
        text: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {flash && (
        <div className={`settings-flash settings-flash-${flash.kind}`}>
          {flash.text}
          <button onClick={() => setFlash(null)} aria-label="閉じる">×</button>
        </div>
      )}

      <section className="settings-section">
        <div className="settings-section-head">
          <h2>Google 連携</h2>
          <p className="settings-section-sub">
            Calendar / Gmail (読み取り) を Yui に許可します。
            連携すると「今日の予定」「未読メール」等の質問に答えられるようになります。
          </p>
        </div>

        <div className="settings-section-body">
          {status.loading && <p className="settings-muted">読み込み中…</p>}

          {!status.loading && !status.clientConfigured && (
            <div className="settings-warn">
              <strong>未セットアップ</strong>
              <p>
                .env に <code>GOOGLE_CLIENT_ID</code> /{" "}
                <code>GOOGLE_CLIENT_SECRET</code> /{" "}
                <code>GOOGLE_REDIRECT_URI</code> を設定してください。
                手順は <code>docs/google-oauth-setup.md</code> 参照。
              </p>
            </div>
          )}

          {!status.loading && status.clientConfigured && !status.connected && (
            <div className="settings-row">
              <span className="settings-pill settings-pill-off">未連携</span>
              <button
                className="settings-btn settings-btn-primary"
                onClick={openConnectPopup}
                type="button"
              >
                Google を連携
              </button>
            </div>
          )}

          {!status.loading && status.connected && (
            <div className="settings-row settings-row-stack">
              <div className="settings-row">
                <span className="settings-pill settings-pill-on">Connected ✓</span>
                <span className="settings-mono">{status.email}</span>
              </div>
              <div className="settings-meta">
                スコープ: {status.scopes.map((s) => shortScope(s)).join(" / ")}
                <br />
                連携日時: {new Date(status.connectedAt).toLocaleString("ja-JP")}
              </div>
              <div className="settings-row">
                <button
                  className="settings-btn settings-btn-danger"
                  onClick={disconnect}
                  disabled={busy}
                  type="button"
                >
                  {busy ? "処理中…" : "連携を解除"}
                </button>
                <button
                  className="settings-btn"
                  onClick={openConnectPopup}
                  type="button"
                >
                  別アカウントに切替
                </button>
              </div>
            </div>
          )}
        </div>
      </section>

      <GoogleMapsApiKeySection />
    </>
  );
}

function GoogleMapsApiKeySection() {
  const [current, setCurrent] = useState<string | null>(null);
  const [source, setSource] = useState<"db" | "env" | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/integrations", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        items: Array<{ key: string; value: string | null; source: "db" | "env" | null }>;
      };
      const item = data.items.find((x) => x.key === "google_maps_api_key");
      setCurrent(item?.value ?? null);
      setSource(item?.source ?? null);
    } catch (e) {
      console.warn("[gmaps-key] load failed:", e);
    }
  }, []);
  useEffect(() => {
    // 初回 mount で Google Maps key を fetch。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void load();
  }, [load]);

  const save = async () => {
    const v = draft.trim();
    if (v.length === 0) {
      setFlash({ kind: "err", text: "key を入力してください" });
      return;
    }
    setSaving(true);
    setFlash(null);
    try {
      const res = await fetch("/api/settings/integrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: "google_maps_api_key", value: v }),
      });
      if (res.ok) {
        setDraft("");
        setFlash({ kind: "ok", text: "保存しました" });
        void load();
      } else {
        const j = await res.json().catch(() => ({}));
        setFlash({ kind: "err", text: `失敗: ${j.error ?? res.status}` });
      }
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!confirm("Google Maps API キーを削除します。よろしいですか?")) return;
    const res = await fetch("/api/settings/integrations", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "google_maps_api_key", value: "" }),
    });
    if (res.ok) {
      setFlash({ kind: "ok", text: "削除しました" });
      void load();
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h2>道案内用 Google マップ API キー</h2>
        <p className="settings-section-sub">
          Yui の道案内 / ルート計算で使う Google Maps Directions API のキー。
          Google Cloud Console → Directions API / Geocoding API / Maps Static API を有効化 →
          認証情報で発行した API キーを貼り付けます。OAuth とは別です。
        </p>
      </div>
      <div className="settings-section-body">
        <div className="settings-row settings-row-stack">
          <div className="settings-row">
            <span className="settings-pill" style={{
              background: current ? "rgba(80,160,100,0.15)" : "rgba(45,34,56,0.08)",
              color: current ? "rgb(40,110,60)" : "rgba(45,34,56,0.55)",
            }}>
              {current ? `設定済 (${source === "env" ? ".env" : "DB"})` : "未設定"}
            </span>
            {current && <span className="settings-mono">{current}</span>}
          </div>
          <div className="settings-row" style={{ alignItems: "center", gap: 8 }}>
            <input
              name="google-api-key"
              type="password"
              placeholder="AIzaSy..."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              className="settings-mono"
              style={{
                flex: 1,
                padding: "8px 12px",
                border: "1.5px solid rgba(var(--accent-rgb), 0.3)",
                borderRadius: 8,
                background: "#fff",
                color: "#2d2238",
                fontFamily: "inherit",
                fontSize: 13,
              }}
            />
            <button
              type="button"
              className="settings-btn settings-btn-primary"
              onClick={() => void save()}
              disabled={saving || draft.trim().length === 0}
            >
              {saving ? "保存中…" : "保存"}
            </button>
            {current && (
              <button
                type="button"
                className="settings-btn settings-btn-danger"
                onClick={() => void remove()}
              >削除</button>
            )}
          </div>
          {flash && (
            <div
              className="settings-meta"
              style={{
                color: flash.kind === "ok" ? "rgb(40,110,60)" : "rgb(150,50,50)",
              }}
            >{flash.text}</div>
          )}
        </div>
      </div>
    </section>
  );
}

function shortScope(s: string): string {
  if (s.endsWith("/calendar.readonly")) return "Calendar (read)";
  if (s.endsWith("/gmail.readonly")) return "Gmail (read)";
  if (s === "openid") return "openid";
  if (s === "email") return "email";
  if (s === "profile") return "profile";
  return s;
}
