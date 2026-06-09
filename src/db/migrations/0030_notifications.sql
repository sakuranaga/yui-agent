-- 通知 (お便り) システム — Phase A
-- 設計: docs/notification-system.md §6 データモデル

CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- "morning_brief" / "news" / "diary" / "mail" / "health" / "timer" / "custom"
  importance TEXT NOT NULL,        -- "high" / "normal" / "low" / "silent"
  title TEXT NOT NULL,
  preview TEXT,                    -- トースト / LogModal で表示する 50-80 字の要約
  body_md TEXT,                    -- replay 時に ReportPanel に流す markdown 全文
  payload JSONB,                   -- 種別固有のメタ (例: morning_brief なら entry_date)
  ref_table TEXT,                  -- 元データのテーブル名 (例: "morning_briefs")
  ref_id BIGINT,                   -- 元データの id (replay 時に最新取得し直す用)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  seen_at TIMESTAMPTZ,             -- 「読む」or「すべて既読」で打つ
  dismissed_at TIMESTAMPTZ         -- × で打つ (一覧から消える、DB には残る)
);

CREATE INDEX idx_notifications_session_unread
  ON notifications (session_id, created_at DESC)
  WHERE dismissed_at IS NULL;

CREATE INDEX idx_notifications_session_unseen
  ON notifications (session_id, created_at DESC)
  WHERE seen_at IS NULL AND dismissed_at IS NULL;
