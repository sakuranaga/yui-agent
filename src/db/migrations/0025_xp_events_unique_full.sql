-- 0024 で作った部分 unique (WHERE ref_id IS NOT NULL) を full unique に置換。
-- Drizzle の onConflictDoNothing は target columns のみで decision するため、
-- 部分 unique index には arbiter として認識されず ERROR 42P10 が出る。
-- Postgres は NULL を unique 違反としない (NULLS DISTINCT 既定) ので、
-- full unique にしても ref_id NULL の ad-hoc 加算は許容される。
DROP INDEX IF EXISTS uniq_xp_events_source;
CREATE UNIQUE INDEX IF NOT EXISTS uniq_xp_events_source
  ON xp_events (event_type, ref_table, ref_id);
