-- 見積 (h) UI は廃止。DB カラムも削除。
-- 既存データは消えるが、Gantt 用に使われていた値で復元の必要なし。
ALTER TABLE todos DROP COLUMN IF EXISTS estimate_hours;
