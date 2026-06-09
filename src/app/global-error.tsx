"use client";

// app router の最上位エラー境界。root layout が落ちた時の最終フォールバック。
// 自前で <html>/<body> を出すのが約束事。
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ja">
      <body style={{ fontFamily: "sans-serif", padding: "2rem", color: "#333" }}>
        <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>
          予期せぬエラーが発生しました
        </h1>
        <p style={{ marginBottom: "1rem", color: "#666" }}>
          {error?.digest ? `(ref: ${error.digest})` : null}
        </p>
        <button
          type="button"
          onClick={() => reset()}
          style={{
            padding: "0.5rem 1rem",
            background: "#0070f3",
            color: "white",
            border: "none",
            borderRadius: "4px",
            cursor: "pointer",
          }}
        >
          再読み込み
        </button>
      </body>
    </html>
  );
}
