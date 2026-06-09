-- リマインダー機能 Phase 1
-- 設計: docs/reminders-system.md

CREATE TABLE reminders (
  id              BIGSERIAL PRIMARY KEY,
  session_id      TEXT NOT NULL,
  kind            TEXT NOT NULL,                       -- "habit" | "todo_due" | "event_due" | "custom"
  title           TEXT NOT NULL,                       -- 短い見出し
  extra_prompt    TEXT,                                -- (任意) speak mode 時の追加指示
  schedule        JSONB NOT NULL,                      -- §2.2 once / weekly + lead_minutes
  ref_table       TEXT,                                -- "todos" 等 (back-link)
  ref_id          BIGINT,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at   TIMESTAMPTZ,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  next_due_at     TIMESTAMPTZ,                         -- dispatcher が計算
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT reminders_kind_check CHECK (kind IN ('habit','todo_due','event_due','custom'))
);

CREATE INDEX idx_reminders_enabled_next ON reminders (enabled, next_due_at);
CREATE INDEX idx_reminders_ref          ON reminders (ref_table, ref_id);
CREATE INDEX idx_reminders_session      ON reminders (session_id);

-- 通知マトリックスに reminder_* kind を追加 (デフォルト値、ご主人様が設定 → 通知 tab で上書き可)
INSERT INTO notification_settings (event_kind, mode_online, mode_away, mode_focus, discord_policy, importance) VALUES
  ('reminder_habit',     'speak',  'notify', 'silent', 'away_only', 'normal'),
  ('reminder_todo_due',  'notify', 'notify', 'speak',  'away_only', 'high'),
  ('reminder_event_due', 'notify', 'notify', 'speak',  'away_only', 'high'),
  ('reminder_custom',    'notify', 'notify', 'silent', 'away_only', 'normal')
ON CONFLICT (event_kind) DO NOTHING;
