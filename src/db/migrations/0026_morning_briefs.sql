-- 朝のブリーフィングを日別に永続化。
-- 当日の素材 (schedule / todos / news / mail) を結衣が要約した markdown を保存し、
-- 後で「昨日のブリーフ見せて」等で Yui が tool 経由で参照できるようにする。

CREATE TABLE IF NOT EXISTS morning_briefs (
  id BIGSERIAL PRIMARY KEY,
  entry_date DATE NOT NULL UNIQUE,
  markdown TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  source_meta JSONB
);

CREATE INDEX IF NOT EXISTS idx_morning_briefs_date_desc
  ON morning_briefs (entry_date DESC);
