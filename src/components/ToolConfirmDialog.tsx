"use client";

/**
 * Tool confirm dialog: destructive / external_send tool 実行前の user 確認 modal。
 *
 * 設計: docs/tool-architecture.md §4.5 (v3 fix)
 *
 * 動作:
 *   - SSE event "tool_confirm_request" を listen して queue に積む
 *   - queue 先頭を modal として表示
 *   - 「許可」 / 「拒否」 → POST /api/tool-confirm/{token}
 *   - 同時に SSE event "tool_confirm_result" で結果を受け取り (= 別 component で chat に反映)
 *   - ESC / overlay click は「拒否」扱い
 *   - timeout は server 側 TTL (10 分)、frontend では特に timer 不要
 */
import { useCallback, useEffect, useState } from "react";

const SESSION_STORAGE_KEY = "vroid-chat-session-id";

export type ToolConfirmRequest = {
  token: string;
  toolName: string;
  summary: string;
  inputSnapshot?: unknown;
};

export default function ToolConfirmDialog() {
  const [queue, setQueue] = useState<ToolConfirmRequest[]>([]);
  const [busy, setBusy] = useState(false);

  // SSE event を listen して queue に積む
  useEffect(() => {
    const onRequest = (e: Event) => {
      const ev = e as CustomEvent<ToolConfirmRequest>;
      if (!ev.detail || !ev.detail.token) return;
      setQueue((q) => [...q, ev.detail]);
    };
    window.addEventListener("yui-tool-confirm-request", onRequest as EventListener);
    return () => {
      window.removeEventListener("yui-tool-confirm-request", onRequest as EventListener);
    };
  }, []);

  const current = queue[0] ?? null;

  const respond = useCallback(
    async (decision: "confirmed" | "denied") => {
      if (!current || busy) return;
      setBusy(true);
      try {
        // sessionId は ChatPanel が localStorage に置く同じキーを読む。
        // server 側で pending.sessionId と照合される (= 403 mismatch 防御)。
        const sessionId =
          typeof window !== "undefined"
            ? window.localStorage.getItem(SESSION_STORAGE_KEY) ?? ""
            : "";
        await fetch(`/api/tool-confirm/${current.token}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ decision, sessionId }),
        });
      } catch {
        /* noop — SSE 経路で結果は別途届く、ここでは静かに進める */
      } finally {
        setBusy(false);
        // queue 先頭を消費
        setQueue((q) => q.slice(1));
      }
    },
    [current, busy]
  );

  // ESC で拒否
  useEffect(() => {
    if (!current) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") void respond("denied");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [current, respond]);

  if (!current) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="ツール実行の確認"
      onClick={(e) => {
        // overlay click (= dialog 自身は stopPropagation する) で拒否扱い
        if (e.target === e.currentTarget) void respond("denied");
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 9999,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "#1a1a1f",
          color: "#eee",
          padding: "1.8rem 2rem",
          borderRadius: "14px",
          width: "100%",
          maxWidth: "32rem",
          boxShadow: "0 10px 40px rgba(0,0,0,0.6)",
          border: "1px solid #2a2a30",
        }}
      >
        <h2
          style={{
            margin: "0 0 0.6rem 0",
            fontSize: "1.1rem",
            color: "#ff8a80",
            letterSpacing: "0.02em",
          }}
        >
          実行確認
        </h2>
        <p style={{ margin: "0 0 0.4rem 0", fontSize: "0.85rem", color: "#999" }}>
          ツール: <code>{current.toolName}</code>
        </p>
        <p
          style={{
            margin: "0.4rem 0 1.4rem 0",
            fontSize: "1rem",
            lineHeight: 1.55,
            wordBreak: "break-all",
          }}
        >
          {current.summary}
        </p>
        {queue.length > 1 && (
          <p style={{ margin: "0 0 1rem 0", color: "#888", fontSize: "0.8rem" }}>
            待機中: 他に {queue.length - 1} 件
          </p>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: "0.8rem" }}>
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond("denied")}
            style={{
              padding: "0.55rem 1.1rem",
              borderRadius: "8px",
              border: "1px solid #444",
              background: "#222",
              color: "#ddd",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: "0.95rem",
            }}
          >
            拒否
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void respond("confirmed")}
            style={{
              padding: "0.55rem 1.1rem",
              borderRadius: "8px",
              border: "none",
              background: busy
                ? "#777"
                : "linear-gradient(135deg, #ec407a, #ad1457)",
              color: "#fff",
              cursor: busy ? "not-allowed" : "pointer",
              fontSize: "0.95rem",
              fontWeight: 600,
            }}
          >
            {busy ? "送信中…" : "許可"}
          </button>
        </div>
      </div>
    </div>
  );
}
