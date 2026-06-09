-- ヘルス目標 (体重・歩数・食事 kcal 等の目標管理)
-- 3 kind: one_time_by_date / daily_min / daily_max
-- 設計: docs/health-goals.md

CREATE TABLE IF NOT EXISTS health_goals (
  id              BIGSERIAL PRIMARY KEY,
  metric_key      TEXT NOT NULL,
  kind            TEXT NOT NULL,                -- "one_time_by_date" | "daily_min" | "daily_max"
  target_value    REAL NOT NULL,
  baseline_value  REAL,                         -- one_time_by_date のみ (開始時点の値)
  deadline        DATE,                         -- one_time_by_date のみ必須
  start_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  label           TEXT,                         -- 表示用
  enabled         BOOLEAN NOT NULL DEFAULT true,
  notes           TEXT,
  achieved_at     TIMESTAMPTZ,                  -- one_time が達成された日時
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_health_goals_metric ON health_goals (metric_key, enabled);
CREATE INDEX IF NOT EXISTS idx_health_goals_kind ON health_goals (kind, enabled);
