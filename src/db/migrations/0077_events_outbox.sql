CREATE TABLE IF NOT EXISTS events_outbox (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload JSONB NOT NULL,
  dedup_key TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  priority INTEGER NOT NULL DEFAULT 100,
  source_job_id TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_events_outbox_dedup_key
  ON events_outbox (dedup_key)
  WHERE dedup_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_outbox_ready
  ON events_outbox (session_id, delivered_at, available_at, priority, created_at);
