-- Timers and reminders.
--
-- kind:
--   'timer'    = 相対時間カウントダウン (UI: 残り時間)
--   'reminder' = 絶対時刻アラーム (UI: 時刻 + ラベル静的表示)
--
-- 両者ともサーバー側で setTimeout で発火 → SSE で frontend に通知。
-- boot 時に pending を全部 re-arm するので、リロード / プロセス再起動でも消えない。

CREATE TABLE IF NOT EXISTS timers (
  id          BIGSERIAL PRIMARY KEY,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('timer','reminder')),
  label       TEXT,
  target_at   TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','fired','cancelled')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fired_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_timers_status_target
  ON timers (status, target_at);
CREATE INDEX IF NOT EXISTS idx_timers_session
  ON timers (session_id);
