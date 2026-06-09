-- email / phone / address の primary 単一カラムを廃止。
-- phones / emails / addresses JSONB 配列に一本化し、Yui が常に複数値を扱う前提に統一。
ALTER TABLE contacts
  DROP COLUMN IF EXISTS email,
  DROP COLUMN IF EXISTS phone,
  DROP COLUMN IF EXISTS address;
