"use client";

/**
 * MCP 連携セクション (docs/yui-mcp-server.md §4.3 / §7)。
 *
 * Claude Code / Codex 等から ゆいの MCP サーバ (/api/mcp) に接続するための
 * `claude mcp add` コマンド と JSON スニペット (URL + token 入り) をコピペできる形で表示。
 * トークンの再生成 (ローテート) もここから。
 *
 * トークン平文を扱うので API は cookie 認証必須 (/api/settings/mcp-token、PUBLIC_PATHS 外)。
 * 接続元 host は可変なので URL は window.location.origin から組み立てる。
 */
import { useCallback, useEffect, useState } from "react";

function CopyIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
      <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
    </svg>
  );
}
function RotateIcon() {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
      <path d="M3 21v-5h5" />
    </svg>
  );
}

export default function McpIntegrationSection() {
  const [token, setToken] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  const origin = typeof window !== "undefined" ? window.location.origin : "";
  const url = `${origin}/api/mcp`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/settings/mcp-token", { cache: "no-store" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "トークンの取得に失敗しました");
        return;
      }
      const data = (await res.json()) as { token: string };
      setToken(data.token);
    } catch {
      setError("トークンの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 初回マウント時の fetch
    void load();
  }, [load]);

  const rotate = async () => {
    if (rotating) return;
    if (!window.confirm("トークンを再生成します。旧トークンは即無効になり、Claude Code 側も貼り直しが必要です。続けますか?")) {
      return;
    }
    setRotating(true);
    try {
      const res = await fetch("/api/settings/mcp-token", { method: "POST" });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        setError(j.error ?? "再生成に失敗しました");
        return;
      }
      const data = (await res.json()) as { token: string };
      setToken(data.token);
      setRevealed(true);
    } catch {
      setError("再生成に失敗しました");
    } finally {
      setRotating(false);
    }
  };

  const addCommand =
    token && origin
      ? `claude mcp add --transport http yui ${url} --header "Authorization: Bearer ${token}"`
      : "";

  const jsonConfig =
    token && origin
      ? JSON.stringify(
          { mcpServers: { yui: { type: "http", url, headers: { Authorization: `Bearer ${token}` } } } },
          null,
          2
        )
      : "";

  const copy = async (label: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied((c) => (c === label ? null : c)), 1500);
    } catch {
      // クリップボード不可環境は無視 (手動選択でコピー)
    }
  };

  return (
    <section className="settings-section">
      <div className="settings-section-head">
        <h3>MCP 連携</h3>
        <p className="settings-section-sub">
          Claude Code / Codex から ゆいのノート・TODO・リマインダーを操作し、作業連絡を受け取れます。
          下のコマンドを Claude Code に追加してください。
        </p>
      </div>

      <div className="settings-section-body">
        {loading && <p className="settings-muted">読み込み中…</p>}
        {error && <div className="settings-warn">{error}</div>}

        {!loading && !error && token && (
          <>
            <p className="settings-section-sub" style={{ marginTop: 0 }}>
              接続コマンド (ターミナルで実行):
            </p>
            <div className="settings-row" style={{ alignItems: "flex-start", gap: 8 }}>
              <code className="settings-mono" style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {revealed
                  ? addCommand
                  : addCommand.replace(token, "••••••••••••••••")}
              </code>
              <button type="button" className="settings-btn" onClick={() => copy("cmd", addCommand)} title="コマンドをコピー">
                <CopyIcon /> {copied === "cmd" ? "コピー済" : "コピー"}
              </button>
            </div>

            <p className="settings-section-sub">または MCP 設定 JSON (手動設定派向け):</p>
            <div className="settings-row" style={{ alignItems: "flex-start", gap: 8 }}>
              <code className="settings-mono" style={{ flex: 1, whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
                {revealed ? jsonConfig : jsonConfig.replace(token, "••••••••••••••••")}
              </code>
              <button type="button" className="settings-btn" onClick={() => copy("json", jsonConfig)} title="JSON をコピー">
                <CopyIcon /> {copied === "json" ? "コピー済" : "コピー"}
              </button>
            </div>

            <div className="settings-row" style={{ gap: 8, marginTop: 12 }}>
              <button type="button" className="settings-btn" onClick={() => setRevealed((v) => !v)}>
                {revealed ? "トークンを隠す" : "トークンを表示"}
              </button>
              <button type="button" className="settings-btn" onClick={rotate} disabled={rotating} title="トークンを再生成">
                <RotateIcon /> {rotating ? "再生成中…" : "トークン再生成"}
              </button>
            </div>
            <p className="settings-section-sub" style={{ marginTop: 8 }}>
              ※ トークンは秘密情報です。漏れた場合は「トークン再生成」で無効化してください。
            </p>
          </>
        )}
      </div>
    </section>
  );
}
