"use client";

/**
 * /auth — トークン入力ログイン画面。
 *
 * UX:
 *   - .env の AUTH_TOKEN を 1 度貼り付け → cookie に保存 → 以降透過
 *   - 失敗時は 1 秒 sleep (server side) + エラー表示
 *   - 成功時は ?next= で元 URL に復帰、無ければ / へ
 */
import { Suspense, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Open-redirect ガード: ?next= で受け取った遷移先を「同一 origin の絶対パスのみ」に制限。
 *   - "/foo"        → 許可 (= 同一 origin)
 *   - "//evil.com"  → 拒否 (= protocol-relative で別ホストに飛ぶ)
 *   - "https://..." → 拒否
 *   - 不正な値      → "/" にフォールバック
 */
function sanitizeNext(raw: string | null): string {
  if (!raw) return "/";
  if (!raw.startsWith("/")) return "/";
  if (raw.startsWith("//")) return "/";
  return raw;
}

function AuthForm() {
  const router = useRouter();
  const params = useSearchParams();
  const next = sanitizeNext(params.get("next"));

  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: token.trim() }),
      });
      if (res.ok) {
        // 成功 → next URL に遷移 (SPA navigation で middleware が cookie を見て pass-through)
        router.replace(next);
        return;
      }
      if (res.status === 503) {
        setError("サーバ側で AUTH_TOKEN が未設定です。.env を確認してください。");
      } else {
        setError("トークンが一致しません。");
      }
    } catch {
      setError("通信エラーが発生しました。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form
      onSubmit={onSubmit}
      style={{
        background: "#18181d",
        padding: "2rem",
        borderRadius: "12px",
        width: "100%",
        maxWidth: "28rem",
        boxShadow: "0 10px 40px rgba(0,0,0,0.5)",
      }}
    >
      <h1
        style={{
          margin: "0 0 0.5rem 0",
          fontSize: "1.5rem",
          letterSpacing: "0.02em",
        }}
      >
        Yui Agent
      </h1>
      <p style={{ margin: "0 0 1.5rem 0", color: "#999", fontSize: "0.9rem" }}>
        サーバ側 <code style={{ color: "#f48fb1" }}>.env</code> の{" "}
        <code style={{ color: "#f48fb1" }}>AUTH_TOKEN</code> を貼り付けてください。
      </p>

      <label
        style={{
          display: "block",
          fontSize: "0.85rem",
          color: "#bbb",
          marginBottom: "0.4rem",
        }}
      >
        トークン
      </label>
      <input
        name="auth-token"
        type="password"
        value={token}
        onChange={(e) => setToken(e.target.value)}
        autoFocus
        autoComplete="current-password"
        spellCheck={false}
        placeholder="AUTH_TOKEN を貼り付け"
        style={{
          width: "100%",
          padding: "0.7rem 0.9rem",
          background: "#222",
          border: "1px solid #333",
          borderRadius: "8px",
          color: "#fff",
          fontSize: "1rem",
          fontFamily: "ui-monospace, monospace",
          boxSizing: "border-box",
        }}
      />

      {error && (
        <p
          style={{
            margin: "0.8rem 0 0 0",
            color: "#ff8a80",
            fontSize: "0.85rem",
          }}
        >
          {error}
        </p>
      )}

      <button
        type="submit"
        disabled={busy || token.trim().length === 0}
        style={{
          marginTop: "1.2rem",
          width: "100%",
          padding: "0.7rem",
          background:
            busy || token.trim().length === 0
              ? "#444"
              : "linear-gradient(135deg, #ec407a, #ad1457)",
          color: "#fff",
          border: "none",
          borderRadius: "8px",
          fontSize: "1rem",
          cursor:
            busy || token.trim().length === 0 ? "not-allowed" : "pointer",
          fontWeight: 600,
        }}
      >
        {busy ? "認証中…" : "ログイン"}
      </button>
    </form>
  );
}

export default function AuthPage() {
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
      {/* Next 16: useSearchParams() を使うコンポーネントは Suspense 境界必須。 */}
      <Suspense fallback={null}>
        <AuthForm />
      </Suspense>
    </div>
  );
}
