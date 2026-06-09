-- 結衣の日記 (1 日 1 エントリ、人間が読んで楽しむ用)。
-- memory_chunks とは別経路: factual retrieval ではなく主観・感情込み。
-- Yui からは on-demand tool 経由でのみ参照、自動 retrieval には流さない。
CREATE TABLE IF NOT EXISTS diary_entries (
  id BIGSERIAL PRIMARY KEY,
  entry_date DATE NOT NULL UNIQUE,    -- 1 日 1 行
  body TEXT NOT NULL,                  -- 結衣口調の本文
  mood TEXT,                           -- happy/calm/melancholic/excited 等 (任意)
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  model_used TEXT,
  source_meta JSONB                    -- 元素材メタ (会話件数/天気/曲数/done todos 等)
);
CREATE INDEX IF NOT EXISTS idx_diary_entries_date
  ON diary_entries (entry_date DESC);
-- 本文全文検索 (簡易: pg_trgm 入れてないので ILIKE で十分)
CREATE INDEX IF NOT EXISTS idx_diary_entries_generated_at
  ON diary_entries (generated_at DESC);
