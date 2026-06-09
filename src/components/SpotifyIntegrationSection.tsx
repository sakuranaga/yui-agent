"use client";

/**
 * Spotify 連携セクション。
 *
 * 流れ:
 *   1. Spotify Developer Dashboard で App 作成 → Client ID / Secret 取得
 *   2. このセクションで Client ID / Secret を入力 → 保存
 *   3. 「連携」ボタン → /api/spotify/authorize → Spotify 同意画面 → callback で /settings に戻る
 *   4. ?connected= / ?error= クエリで成功/失敗 flash
 *
 * 単一 user 前提なので OAuth は popup ではなく same-tab redirect で完結する
 * (= GoogleIntegrationSection は popup を使ってるが、Spotify は完了後 /settings に
 *  戻すだけで十分シンプル)。
 */
import { useCallback, useEffect, useState } from "react";

// 表示用の Spotify Dashboard 登録 URI (= 設定 → 連携タブ で「これをコピーして dashboard に登録」と案内する文字列)。
// 実際の OAuth で使われる redirect_uri は server 側 env SPOTIFY_REDIRECT_URI で決まる。
const REDIRECT_URI =
  typeof window !== "undefined"
    ? `${window.location.origin}/api/spotify/callback`
    : "https://localhost:8443/api/spotify/callback";

type Status =
  | { loading: true }
  | {
      loading: false;
      connected: false;
      clientConfigured: boolean;
      apiWorking: false;
      error?: string;
    }
  | {
      loading: false;
      connected: true;
      clientConfigured: true;
      apiWorking: true;
      me?: { id: string; display_name: string; product: "free" | "premium" };
      product?: "free" | "premium";
      tokenExpiresAt?: string | null;
    }
  | {
      // 連携済だが API が叩けない (= dev mode の Premium block / token 失効等)
      loading: false;
      connected: true;
      clientConfigured: true;
      apiWorking: false;
      errorCode?: "not_connected" | "premium_required" | "unknown";
      tokenExpiresAt?: string | null;
    };

type IntegrationItem = {
  key: string;
  value: string | null;
  masked: boolean;
  source: "db" | "env" | null;
};

type Props = {
  initialFlash?: { kind: "ok" | "err"; text: string } | null;
};

export default function SpotifyIntegrationSection({ initialFlash = null }: Props) {
  const [status, setStatus] = useState<Status>({ loading: true });
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<{ kind: "ok" | "err"; text: string } | null>(
    initialFlash
  );

  // Client ID / Secret の編集 state
  const [clientIdItem, setClientIdItem] = useState<IntegrationItem | null>(null);
  const [clientSecretItem, setClientSecretItem] = useState<IntegrationItem | null>(null);
  const [draftId, setDraftId] = useState("");
  const [draftSecret, setDraftSecret] = useState("");
  const [savingCred, setSavingCred] = useState(false);

  const reloadStatus = useCallback(async () => {
    setStatus({ loading: true });
    try {
      const res = await fetch("/api/spotify/status", { cache: "no-store" });
      const data = await res.json();
      setStatus({ loading: false, ...data });
      // IconBar 等の他コンポーネントに「Spotify status 再評価」を促す
      try {
        window.dispatchEvent(
          new CustomEvent("yui-spotify-status-change", {
            detail: {
              apiWorking: !!data.apiWorking,
              connected: !!data.connected,
            },
          })
        );
      } catch { /* noop */ }
    } catch (e) {
      setStatus({
        loading: false,
        connected: false,
        clientConfigured: false,
        apiWorking: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, []);

  const reloadCreds = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/integrations", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as { items: IntegrationItem[] };
      setClientIdItem(data.items.find((x) => x.key === "spotify_client_id") ?? null);
      setClientSecretItem(
        data.items.find((x) => x.key === "spotify_client_secret") ?? null
      );
    } catch (e) {
      console.warn("[spotify-creds] load failed:", e);
    }
  }, []);

  useEffect(() => {
    // 初回 mount + reload 関数が変わったら再 fetch。reload* 内 setState は async 後で cascade ではない。
    // eslint-disable-next-line react-hooks/set-state-in-effect -- on-mount fetch
    void reloadStatus();
    void reloadCreds();
  }, [reloadStatus, reloadCreds]);

  async function saveCred(key: "spotify_client_id" | "spotify_client_secret", value: string) {
    setSavingCred(true);
    try {
      const res = await fetch("/api/settings/integrations", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        setFlash({ kind: "err", text: `保存失敗: ${j.error ?? res.status}` });
      } else {
        setFlash({ kind: "ok", text: "保存しました" });
      }
    } finally {
      setSavingCred(false);
      await reloadCreds();
      await reloadStatus();
    }
  }

  async function saveBoth() {
    if (draftId.trim().length > 0) {
      await saveCred("spotify_client_id", draftId.trim());
      setDraftId("");
    }
    if (draftSecret.trim().length > 0) {
      await saveCred("spotify_client_secret", draftSecret.trim());
      setDraftSecret("");
    }
  }

  function startAuthorize() {
    // Caddy + HTTPS 移行後は redirect URI を https://localhost:8443/api/spotify/callback に
    // 揃えたので、現 origin (= https://localhost:8443) のまま authorize に進む。
    // Spotify Dashboard 側にも同じ URI を登録しておく必要あり。
    window.location.href = "/api/spotify/authorize";
  }

  async function disconnect() {
    if (!confirm("Spotify 連携を解除しますか?")) return;
    setBusy(true);
    try {
      const res = await fetch("/api/spotify/disconnect", { method: "POST" });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setFlash({ kind: "ok", text: "連携を解除しました" });
      await reloadStatus();
    } catch (e) {
      setFlash({ kind: "err", text: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  function copyRedirectUri() {
    if (typeof navigator === "undefined" || !navigator.clipboard) return;
    void navigator.clipboard.writeText(REDIRECT_URI);
    setFlash({ kind: "ok", text: "redirect URI をコピーしました" });
  }

  const connected = !status.loading && status.connected;
  const clientConfigured = !status.loading && status.clientConfigured;

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
          <h2>Spotify 連携</h2>
          <p className="settings-section-sub">
            Spotify と連携すると、Yui に「ジャズ流して」「次の曲」「音量上げて」のように
            音楽操作を依頼できます。
            <br />
            <strong>⚠️ Spotify Premium が必須</strong>: Spotify の仕様 (2024〜) により、Web API は
            <strong>アプリ owner が Premium 加入してないと一切叩けません</strong> (Free アカウントの
            アプリでは search/now-playing も含めて全 endpoint がブロックされます)。
          </p>
        </div>

        <div className="settings-section-body">
          {/* 1) Client ID / Secret 入力 */}
          <div className="settings-row settings-row-stack">
            <p className="settings-section-sub" style={{ marginTop: 0 }}>
              <strong>手順 1.</strong>{" "}
              <a
                href="https://developer.spotify.com/dashboard"
                target="_blank"
                rel="noreferrer noopener"
                style={{ textDecoration: "underline" }}
              >
                Spotify Developer Dashboard
              </a>{" "}
              でアプリを作成し、Client ID / Client Secret を取得します。
              <br />
              アプリ設定の <strong>Redirect URI</strong> に下の値を追加してください:
            </p>
            <div className="settings-row" style={{ alignItems: "center", gap: 8 }}>
              <code className="settings-mono" style={{
                flex: 1,
                padding: "8px 12px",
                background: "rgba(45,34,56,0.06)",
                borderRadius: 8,
                fontSize: 12,
              }}>{REDIRECT_URI}</code>
              <button
                type="button"
                className="settings-btn"
                onClick={copyRedirectUri}
              >コピー</button>
            </div>

            <p className="settings-section-sub">
              <strong>手順 2.</strong> 取得した Client ID / Client Secret を貼り付けて保存:
            </p>
            <div className="settings-row" style={{ alignItems: "center", gap: 8 }}>
              <span className="settings-pill" style={{
                background: clientIdItem?.value ? "rgba(80,160,100,0.15)" : "rgba(45,34,56,0.08)",
                color: clientIdItem?.value ? "rgb(40,110,60)" : "rgba(45,34,56,0.55)",
                minWidth: 90,
                textAlign: "center",
              }}>
                {clientIdItem?.value
                  ? `Client ID (${clientIdItem.source === "env" ? ".env" : "DB"})`
                  : "Client ID 未設定"}
              </span>
              <input
                name="spotify-client-id"
                type="password"
                placeholder={clientIdItem?.value ? "新しい値で上書きする場合のみ入力" : "Client ID"}
                value={draftId}
                onChange={(e) => setDraftId(e.target.value)}
                className="settings-mono"
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  border: "1.5px solid rgba(var(--accent-rgb), 0.3)",
                  borderRadius: 8,
                  background: "#fff",
                  color: "#2d2238",
                  fontSize: 13,
                }}
              />
            </div>
            <div className="settings-row" style={{ alignItems: "center", gap: 8 }}>
              <span className="settings-pill" style={{
                background: clientSecretItem?.value ? "rgba(80,160,100,0.15)" : "rgba(45,34,56,0.08)",
                color: clientSecretItem?.value ? "rgb(40,110,60)" : "rgba(45,34,56,0.55)",
                minWidth: 90,
                textAlign: "center",
              }}>
                {clientSecretItem?.value
                  ? `Secret (${clientSecretItem.source === "env" ? ".env" : "DB"})`
                  : "Secret 未設定"}
              </span>
              <input
                name="spotify-client-secret"
                type="password"
                placeholder={clientSecretItem?.value ? "新しい値で上書きする場合のみ入力" : "Client Secret"}
                value={draftSecret}
                onChange={(e) => setDraftSecret(e.target.value)}
                className="settings-mono"
                style={{
                  flex: 1,
                  padding: "8px 12px",
                  border: "1.5px solid rgba(var(--accent-rgb), 0.3)",
                  borderRadius: 8,
                  background: "#fff",
                  color: "#2d2238",
                  fontSize: 13,
                }}
              />
              <button
                type="button"
                className="settings-btn settings-btn-primary"
                onClick={() => void saveBoth()}
                disabled={
                  savingCred ||
                  (draftId.trim().length === 0 && draftSecret.trim().length === 0)
                }
              >
                {savingCred ? "保存中…" : "保存"}
              </button>
            </div>
          </div>

          {/* 2) 連携状態 */}
          <hr style={{ border: 0, borderTop: "1px solid rgba(45,34,56,0.1)", margin: "16px 0" }} />

          {status.loading && <p className="settings-muted">読み込み中…</p>}

          {!status.loading && !clientConfigured && (
            <div className="settings-warn">
              <strong>Client ID / Secret 未設定</strong>
              <p>上のフォームから Spotify アプリの認証情報を保存してください。</p>
            </div>
          )}

          {!status.loading && clientConfigured && !connected && (
            <div className="settings-row">
              <span className="settings-pill settings-pill-off">未連携</span>
              <button
                className="settings-btn settings-btn-primary"
                onClick={startAuthorize}
                type="button"
              >
                Spotify と連携
              </button>
            </div>
          )}

          {!status.loading && status.connected && status.apiWorking && (
            <div className="settings-row settings-row-stack">
              <div className="settings-row">
                <span className="settings-pill settings-pill-on">Connected ✓</span>
                <span className="settings-mono">
                  {status.me?.display_name ?? "(unknown)"}
                </span>
                {status.me?.product && (
                  <span
                    className="settings-pill"
                    style={{
                      marginLeft: 8,
                      background:
                        status.me.product === "premium"
                          ? "rgba(80,160,100,0.15)"
                          : "rgba(200,140,40,0.18)",
                      color:
                        status.me.product === "premium"
                          ? "rgb(40,110,60)"
                          : "rgb(160,100,20)",
                    }}
                  >
                    {status.me.product === "premium" ? "Premium" : "Free"}
                  </span>
                )}
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
                  onClick={startAuthorize}
                  type="button"
                >
                  別アカウントで再連携
                </button>
              </div>
            </div>
          )}

          {!status.loading && status.connected && !status.apiWorking && (
            <div className="settings-row settings-row-stack">
              <div className="settings-row">
                <span className="settings-pill settings-pill-off">連携済だが API ブロック</span>
              </div>
              <div className="settings-warn">
                <strong>Spotify Web API にアクセスできません。</strong>
                <p style={{ margin: "6px 0 0" }}>
                  ほぼ確実に「アプリ owner (= ご主人様の Spotify アカウント) が
                  <strong>Premium 未加入</strong>」が原因です。Spotify の仕様で
                  Development Mode のアプリは owner が Premium じゃないと API 全部 403 で
                  ブロックされます (test users 登録しても効きません)。
                </p>
                <p style={{ margin: "6px 0 0", fontSize: 12, opacity: 0.85 }}>
                  サーバから返ってきた error 分類:{" "}
                  <code className="settings-mono" style={{ fontSize: 11 }}>
                    {status.errorCode ?? "unknown"}
                  </code>
                  {" "}
                  (詳細はサーバ log を確認してください)
                </p>
                <p style={{ margin: "8px 0 0" }}>
                  <a
                    href="https://www.spotify.com/jp/premium/"
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{ textDecoration: "underline" }}
                  >
                    Spotify Premium に加入
                  </a>{" "}
                  すると即解消します。加入後この設定ページをリロードしてください。
                </p>
              </div>
              <div className="settings-row">
                <button
                  className="settings-btn"
                  onClick={() => void reloadStatus()}
                  disabled={status.loading}
                  type="button"
                >
                  再確認
                </button>
                <button
                  className="settings-btn settings-btn-danger"
                  onClick={disconnect}
                  disabled={busy}
                  type="button"
                >
                  {busy ? "処理中…" : "連携を解除"}
                </button>
              </div>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
