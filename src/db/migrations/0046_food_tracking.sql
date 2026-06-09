-- 食事ログ + 栄養 cache + 体メトリクス
-- 設計: docs/food-tracking.md §4

CREATE TABLE IF NOT EXISTS food_logs (
  id                BIGSERIAL PRIMARY KEY,
  eaten_at          TIMESTAMPTZ NOT NULL,
  raw_text          TEXT NOT NULL,
  items             JSONB NOT NULL,            -- [{name, quantity, unit, kcal, protein, carbs, fat, fiber, ref_id?}]
  total_kcal        REAL,
  total_protein     REAL,
  total_carbs       REAL,
  total_fat         REAL,
  total_fiber       REAL,
  source_message_id BIGINT REFERENCES raw_messages(id) ON DELETE SET NULL,
  notes             TEXT,
  confidence        REAL NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_food_logs_eaten_at ON food_logs (eaten_at);
CREATE INDEX IF NOT EXISTS idx_food_logs_source_message ON food_logs (source_message_id);

CREATE TABLE IF NOT EXISTS food_reference (
  normalized_name TEXT PRIMARY KEY,
  unit            TEXT NOT NULL,
  kcal_per_unit   REAL NOT NULL,
  protein         REAL,
  carbs           REAL,
  fat             REAL,
  fiber           REAL,
  source_url      TEXT,
  confidence      TEXT NOT NULL,  -- "high" / "medium" / "low"
  looked_up_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS body_metrics (
  id                BIGSERIAL PRIMARY KEY,
  metric_type       TEXT NOT NULL,
  value             REAL NOT NULL,
  recorded_at       TIMESTAMPTZ NOT NULL,
  notes             TEXT,
  source            TEXT NOT NULL DEFAULT 'manual',
  source_message_id BIGINT REFERENCES raw_messages(id) ON DELETE SET NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_body_metrics_type_time
  ON body_metrics (metric_type, recorded_at DESC);
