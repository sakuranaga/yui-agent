CREATE TABLE IF NOT EXISTS event_clients (
  client_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  replay_from_event_id BIGINT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_clients_session
  ON event_clients (session_id, updated_at DESC);
