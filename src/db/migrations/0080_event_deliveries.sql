CREATE TABLE IF NOT EXISTS event_deliveries (
  event_id BIGINT NOT NULL REFERENCES events_outbox(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  delivered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (event_id, client_id)
);

CREATE INDEX IF NOT EXISTS idx_event_deliveries_client
  ON event_deliveries (client_id, delivered_at DESC);
