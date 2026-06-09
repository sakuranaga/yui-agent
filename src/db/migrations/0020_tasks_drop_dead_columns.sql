-- tasks テーブルの write-only / 完全未使用カラムを一括 drop。
-- 全カラムについて src/, apps/ 全 grep で read site 無しを確認済み。
--   - pending_acknowledgement: dispatcher.ts:195/254 で書き込みのみ、読み出し 0 件 (partial index も自動 cascade で drop)
--   - acknowledged_at:        書き込みも読み出しも 0 件
--   - deadline:               書き込みも読み出しも 0 件
--   - resulting_chunk_id:     書き込みも読み出しも 0 件 (FK 制約も自動 drop)
--   - external_ref_system:    Plane 廃止後 caller 無し
--   - external_ref_id:        同上
--   - metadata (tasks):       書き込みも読み出しも 0 件
-- memory_chunks.metadata は別テーブルで生存中、touch しない。
ALTER TABLE tasks
  DROP COLUMN IF EXISTS pending_acknowledgement,
  DROP COLUMN IF EXISTS acknowledged_at,
  DROP COLUMN IF EXISTS deadline,
  DROP COLUMN IF EXISTS resulting_chunk_id,
  DROP COLUMN IF EXISTS external_ref_system,
  DROP COLUMN IF EXISTS external_ref_id,
  DROP COLUMN IF EXISTS metadata;
