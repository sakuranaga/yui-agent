-- 通知マトリックス設定 — Phase E
-- 設計: docs/notification-system.md §6.5

CREATE TABLE notification_settings (
  event_kind TEXT PRIMARY KEY,        -- "morning_brief" / "news" / "diary" / "mail_important" / "mail_other" / "music" / "health" / "timer"
  mode_online TEXT NOT NULL,           -- "speak" / "notify" / "silent"
  mode_away   TEXT NOT NULL,
  mode_focus  TEXT NOT NULL,
  discord_policy TEXT NOT NULL,        -- "always" / "away_only" / "never"
  importance TEXT NOT NULL,            -- "high" / "normal" / "low"
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- デフォルトマトリックス seed (起動時 lib 側で UPSERT する設計だが、初期 INSERT も入れておく)
INSERT INTO notification_settings (event_kind, mode_online, mode_away, mode_focus, discord_policy, importance) VALUES
  ('timer',          'speak',  'speak',  'speak',  'away_only', 'high'),
  ('morning_brief',  'notify', 'notify', 'notify', 'always',    'normal'),
  ('diary',          'notify', 'notify', 'notify', 'away_only', 'low'),
  ('news',           'notify', 'notify', 'notify', 'away_only', 'low'),
  ('mail_important', 'speak',  'notify', 'notify', 'away_only', 'high'),
  ('mail_other',     'notify', 'notify', 'notify', 'away_only', 'normal'),
  ('music',          'speak',  'silent', 'silent', 'never',     'low'),
  ('health',         'speak',  'notify', 'notify', 'away_only', 'high')
ON CONFLICT (event_kind) DO NOTHING;
