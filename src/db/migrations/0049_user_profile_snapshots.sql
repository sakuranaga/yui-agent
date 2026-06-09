-- ご主人様プロファイル スナップショット (1 日 1 件、データ駆動の客観アセスメント)
-- 日記とは別レコード・別生成パイプ。
-- 設計: docs/user-profile-snapshot.md

CREATE TABLE IF NOT EXISTS user_profile_snapshots (
  id                    BIGSERIAL PRIMARY KEY,
  snapshot_date         DATE NOT NULL UNIQUE,
  personality           TEXT NOT NULL,
  communication_style   TEXT NOT NULL,
  current_focus         TEXT NOT NULL,
  mood_trend            TEXT NOT NULL,
  inferred_traits       TEXT NOT NULL,
  evidence_notes        TEXT,
  inferred_image_prompt TEXT,
  source_meta           JSONB,
  generated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  generated_by          TEXT NOT NULL DEFAULT 'cron'
);
CREATE INDEX IF NOT EXISTS idx_user_profile_snapshots_date
  ON user_profile_snapshots (snapshot_date DESC);
