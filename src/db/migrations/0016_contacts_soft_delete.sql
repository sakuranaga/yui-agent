-- 連絡先の論理削除カラム。Yui からの delete_contact は deleted_at セットに切替、
-- 物理削除は永久に保留 (ユーザーが手で SQL 叩く時のみ)。
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

-- アクティブ行を高速 lookup
CREATE INDEX IF NOT EXISTS idx_contacts_active
  ON contacts (id)
  WHERE deleted_at IS NULL;
