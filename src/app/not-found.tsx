// Next.js 16 が自動生成する _not-found も prerender 時に useContext null で
// 落ちる (global-error と同種のフレームワークバグ)。自前で最小実装を置いて
// root layout 経由の prerender を成立させる。
export default function NotFound() {
  return (
    <div style={{ padding: "2rem", fontFamily: "sans-serif", color: "#333" }}>
      <h1 style={{ fontSize: "1.5rem", marginBottom: "1rem" }}>404</h1>
      <p>お探しのページは見つかりませんでした。</p>
    </div>
  );
}
