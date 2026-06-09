-- ニュースキュレーション機構
-- 設計: docs/news-curation.md

-- 既存 news_articles に curation スコアを追加
-- score: NULL = 未キュレーション、0.0〜1.0
-- score_reason: Haiku が付けた短い根拠 ("新モデル" 等)
-- curated_at: いつ curate されたか
ALTER TABLE news_articles
  ADD COLUMN score REAL,
  ADD COLUMN score_reason TEXT,
  ADD COLUMN curated_at TIMESTAMPTZ;

CREATE INDEX idx_news_articles_score
  ON news_articles (score DESC NULLS LAST)
  WHERE score IS NOT NULL;

-- 設定 singleton。CHECK (id = 1) で 1 行のみ保証
CREATE TABLE news_curation_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  interest_profile TEXT NOT NULL DEFAULT '',
  score_threshold REAL NOT NULL DEFAULT 0.6,
  min_speak_interval_hours INTEGER NOT NULL DEFAULT 1,
  last_spoken_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO news_curation_settings (id, interest_profile)
VALUES (1, '')
ON CONFLICT (id) DO NOTHING;
