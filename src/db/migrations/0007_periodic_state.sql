-- Periodic Module の前回 run 結果 (snapshot) を保持。
-- 1 module = 1 行。ID は module の id 文字列。
CREATE TABLE IF NOT EXISTS periodic_state (
  module_id TEXT PRIMARY KEY,
  snapshot JSONB,
  last_run_at TIMESTAMPTZ,
  last_fired_at TIMESTAMPTZ
);
