-- VCF (vCard) 準拠フィールド追加。
-- email / phone / address は引き続き primary 1 件として保持 (Yui の表示・検索用)、
-- 複数値は emails / phones / addresses JSONB 配列に格納。
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS emails JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS phones JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS addresses JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS urls TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS nickname TEXT,
  ADD COLUMN IF NOT EXISTS department TEXT,    -- ORG の 2nd part
  ADD COLUMN IF NOT EXISTS external_ref TEXT;  -- VCF UID で再 import 防止

CREATE INDEX IF NOT EXISTS idx_contacts_external_ref
  ON contacts (external_ref)
  WHERE external_ref IS NOT NULL;
