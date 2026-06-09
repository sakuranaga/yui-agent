-- Wishlist / 軽量 TODO 統合テーブル。
-- Plane は業務タスク、これは個人の「やりたい/欲しい/ちょっとした TODO」用。
-- category は自由文字列 ("本", "ガジェット", "todo", "店" 等)、運用しながら頻出を抽出。
CREATE TABLE IF NOT EXISTS wishes (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  category TEXT,
  title TEXT NOT NULL,
  note TEXT,
  url TEXT,
  -- TODO 用途で期日があるもの。null なら期日なし wish
  due_at TIMESTAMPTZ,
  -- 1 (low) | 2 (mid) | 3 (high)。デフォルト 2
  priority INTEGER NOT NULL DEFAULT 2,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_wishes_session_active
  ON wishes (session_id, completed_at, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_wishes_due
  ON wishes (due_at)
  WHERE due_at IS NOT NULL AND completed_at IS NULL;
