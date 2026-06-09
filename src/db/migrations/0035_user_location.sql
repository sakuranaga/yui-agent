-- ご主人様の位置情報を永続化する (singleton)。
-- これまで in-memory のみで保持していたが、コンテナ再起動 → 日記生成等の周期処理が
-- フロントの再 push より先に走ると weather/place が抜けてしまっていた。
-- 個人用シングルユーザー前提なので CHECK (id = 1) で 1 行のみ。

CREATE TABLE user_location (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  lat DOUBLE PRECISION NOT NULL,
  lon DOUBLE PRECISION NOT NULL,
  accuracy DOUBLE PRECISION,
  place_label TEXT,
  place_label_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
