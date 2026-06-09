"use client";

/**
 * 設定 > データ tab。
 *
 * 内容:
 *  - チャット履歴クリア (Valkey overlay) — プライベート会話 + SSE 由来の ephemeral 発話を即時削除
 *  - (将来) LLM ログのクリア、メモリ統計、エクスポート 等
 */
import { useState } from "react";

const SESSION_KEY = "vroid-chat-session-id";

export default function DataSection() {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: "ok" | "err"; text: string } | null>(null);

  const clearOverlay = async () => {
    if (typeof window === "undefined") return;
    const session = window.localStorage.getItem(SESSION_KEY);
    if (!session) {
      setMsg({ kind: "err", text: "session が見つかりません (まだ会話していない?)" });
      return;
    }
    if (!confirm(
      "Valkey 上の会話履歴 (プライベートモード会話 + ニュース/音楽紹介の SSE-only 発話) を即時削除します。\n" +
      "通常モードの会話 (DB 側) は消えません。よろしいですか?"
    )) return;
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetch(`/api/chat/history?session=${encodeURIComponent(session)}`, {
        method: "DELETE",
      });
      if (res.ok) {
        setMsg({ kind: "ok", text: "クリアしました。リロードで反映されます。" });
      } else {
        const j = await res.json().catch(() => ({}));
        setMsg({ kind: "err", text: `失敗: ${j.error ?? res.status}` });
      }
    } catch (e) {
      setMsg({ kind: "err", text: `失敗: ${e instanceof Error ? e.message : String(e)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="data-section">
      <section className="ai-section">
        <h3 className="ai-section-title">チャット履歴 (Valkey overlay)</h3>
        <p className="ai-hint">
          プライベートモードの会話と、ニュース / 音楽紹介などの SSE 由来 ephemeral 発話を一括削除します。
          通常モードの DB 会話 (raw_messages) は触りません。
          24h で自動的に消えますが、即時に消したいときに使ってください。
        </p>
        <button
          type="button"
          className="data-section-danger-btn"
          onClick={() => void clearOverlay()}
          disabled={busy}
        >
          {busy ? "削除中…" : "Valkey の会話履歴を消す"}
        </button>
        {msg && (
          <div className={`data-section-msg ${msg.kind}`}>{msg.text}</div>
        )}
      </section>
    </div>
  );
}
