-- アーカイブとゴミ箱を別概念にする
-- - deleted_at (旧名) は「アーカイブ」のつもりで使っていたので archived_at にリネーム
-- - trashed_at を新規追加 (ゴミ箱 = 物理削除予備軍)
-- - 既存 row の deleted_at 値はそのまま archived_at にスライド
--
-- UI:
--   受信箱: archived_at IS NULL AND trashed_at IS NULL AND 'SENT' NOT IN labels
--   送信済み: 'SENT' IN labels AND trashed_at IS NULL
--   アーカイブ: archived_at IS NOT NULL AND trashed_at IS NULL
--   ゴミ箱: trashed_at IS NOT NULL  (ここから「ゴミ箱を空にする」で物理削除)

ALTER TABLE mail_messages RENAME COLUMN deleted_at TO archived_at;
ALTER TABLE mail_messages ADD COLUMN trashed_at TIMESTAMPTZ;

-- 既存のインデックスを差し替え
DROP INDEX IF EXISTS idx_mail_received;
DROP INDEX IF EXISTS idx_mail_score;
DROP INDEX IF EXISTS idx_mail_from_email;

CREATE INDEX idx_mail_received   ON mail_messages (received_at DESC)
  WHERE trashed_at IS NULL;
CREATE INDEX idx_mail_score      ON mail_messages (score DESC NULLS LAST)
  WHERE trashed_at IS NULL;
CREATE INDEX idx_mail_from_email ON mail_messages (from_email)
  WHERE trashed_at IS NULL;
CREATE INDEX idx_mail_archived   ON mail_messages (archived_at DESC)
  WHERE archived_at IS NOT NULL AND trashed_at IS NULL;
CREATE INDEX idx_mail_trashed    ON mail_messages (trashed_at DESC)
  WHERE trashed_at IS NOT NULL;
