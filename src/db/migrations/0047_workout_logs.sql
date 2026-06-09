-- 筋トレ / ジム記録
-- 設計: docs/health-tracking.md §11 Phase 3

CREATE TABLE IF NOT EXISTS workout_logs (
  id                BIGSERIAL PRIMARY KEY,
  performed_at      TIMESTAMPTZ NOT NULL,
  body_parts        JSONB NOT NULL,            -- string[] (chest/back/shoulders/legs/arms/core/cardio/full)
  exercises         JSONB NOT NULL,            -- [{name, sets?, reps?, weight_kg?, distance_km?, duration_min?}]
  duration_min      INTEGER,                   -- 全体の所要時間
  intensity         TEXT,                      -- "light" | "normal" | "hard"
  notes             TEXT,
  raw_text          TEXT NOT NULL,
  source_message_id BIGINT REFERENCES raw_messages(id) ON DELETE SET NULL,
  confidence        REAL NOT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_workout_logs_performed_at ON workout_logs (performed_at DESC);
CREATE INDEX IF NOT EXISTS idx_workout_logs_source_message ON workout_logs (source_message_id);
