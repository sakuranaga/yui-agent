CREATE TABLE IF NOT EXISTS tool_confirm_jobs (
  token text PRIMARY KEY,
  session_id text NOT NULL,
  tool_name text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  pending jsonb NOT NULL,
  result jsonb,
  fail_reason text,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz
);

CREATE INDEX IF NOT EXISTS idx_tool_confirm_jobs_status_created
  ON tool_confirm_jobs (status, created_at);

CREATE INDEX IF NOT EXISTS idx_tool_confirm_jobs_session_status
  ON tool_confirm_jobs (session_id, status);
