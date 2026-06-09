-- Phase 1 initial schema
-- See docs/memory-architecture.md §3 for rationale.

CREATE EXTENSION IF NOT EXISTS vector;

-- ===========================================================================
-- raw_messages: every turn, verbatim. Audit/replay source. Not search-indexed.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS raw_messages (
  id         BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content    TEXT NOT NULL,
  emotion    TEXT,
  source     TEXT NOT NULL DEFAULT 'web',
    -- 'web' | 'discord_text' | 'discord_voice' | 'cron'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_raw_messages_session
  ON raw_messages (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_raw_messages_source
  ON raw_messages (source, created_at DESC);

-- ===========================================================================
-- memory_chunks: extracted memory items. Vector-searchable.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS memory_chunks (
  id             BIGSERIAL PRIMARY KEY,
  session_id     TEXT,
  chunk_type     TEXT NOT NULL,
    -- 'fact' | 'preference' | 'event' | 'emotion' | 'summary' |
    -- 'turn_summary' | 'procedural' | 'commitment' | 'task_result' | 'external_ref'
  content        TEXT NOT NULL,
  embedding      vector(1024),
  importance     REAL NOT NULL DEFAULT 0.5,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  actor_type     TEXT NOT NULL DEFAULT 'extraction',
    -- 'extraction' | 'subagent' | 'mcp_sync' | 'user_direct' | 'system'
  actor_id       TEXT,

  source_system  TEXT,    -- 'plane' | 'gcal' | 'gmail' | NULL
  source_id      TEXT,

  -- bi-temporal columns reserved for future Graphiti-style invalidation
  valid_from     TIMESTAMPTZ DEFAULT NOW(),
  valid_to       TIMESTAMPTZ,
  invalidated_at TIMESTAMPTZ,

  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- HNSW index for fast cosine similarity search
CREATE INDEX IF NOT EXISTS idx_memory_chunks_embedding
  ON memory_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_type_importance
  ON memory_chunks (chunk_type, importance DESC);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_created
  ON memory_chunks (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_source_ref
  ON memory_chunks (source_system, source_id)
  WHERE source_system IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_memory_chunks_actor
  ON memory_chunks (actor_type, actor_id);
CREATE INDEX IF NOT EXISTS idx_memory_chunks_content_fts
  ON memory_chunks USING gin (to_tsvector('simple', content));

-- ===========================================================================
-- tasks: Yui-internal orchestration state. Schema only in Phase 1, populated
-- from Phase C onwards. User-managed tasks live in Plane (external SoT).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS tasks (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT,
  initiated_by TEXT NOT NULL,    -- 'yui' | 'user' | 'cron' | 'webhook'
  agent_name   TEXT NOT NULL,    -- 'research_agent' | 'email_agent' | 'inline'
  task_type    TEXT NOT NULL,    -- 'research' | 'draft_email' | 'sync_calendar' | 'proactive_notification'
  status       TEXT NOT NULL DEFAULT 'pending',
    -- 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  input        JSONB NOT NULL,
  output       JSONB,
  error        TEXT,

  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  deadline     TIMESTAMPTZ,

  pending_acknowledgement BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at         TIMESTAMPTZ,

  resulting_chunk_id BIGINT REFERENCES memory_chunks(id) ON DELETE SET NULL,

  external_ref_system TEXT,
  external_ref_id     TEXT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_tasks_status
  ON tasks (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_pending_ack
  ON tasks (pending_acknowledgement) WHERE pending_acknowledgement;
CREATE INDEX IF NOT EXISTS idx_tasks_agent
  ON tasks (agent_name, status);
CREATE INDEX IF NOT EXISTS idx_tasks_session
  ON tasks (session_id, created_at);

-- ===========================================================================
-- proactive_state: tracks last-seen state per source so cron loops are
-- idempotent across restarts. Phase G uses this; Phase 1 just creates it.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS proactive_state (
  key        TEXT PRIMARY KEY,
    -- 'gcal_last_check' | 'gmail_last_check' | 'plane_last_check' | ...
  value      JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===========================================================================
-- _migrations: which files have been applied
-- ===========================================================================
CREATE TABLE IF NOT EXISTS _migrations (
  filename   TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
