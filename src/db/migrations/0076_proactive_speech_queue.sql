CREATE TABLE IF NOT EXISTS proactive_speech_queue (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  source TEXT NOT NULL,
  prompt TEXT,
  speak_text TEXT,
  emotion TEXT,
  priority INTEGER NOT NULL DEFAULT 100,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  available_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_proactive_speech_queue_ready
  ON proactive_speech_queue (session_id, delivered_at, available_at, priority, created_at);
