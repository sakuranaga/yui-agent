-- 秘書 Lv の経験値 (XP) 加算履歴。
-- 各イベント (会話 1 ターン、いいね受領、todo 完了、日記生成 等) で 1 行積み、
-- 累計 SUM(xp) から Lv を導出する。retroactive (過去データから 1 回限り埋める)
-- と live (新規発生時) で同じ INSERT を共有するため、(event_type, ref_table, ref_id)
-- を部分 unique にして重複加算を構造的に防ぐ。

CREATE TABLE IF NOT EXISTS xp_events (
  id BIGSERIAL PRIMARY KEY,
  -- 'chat_turn' / 'heart_received' / 'todo_completed' / 'diary_generated'
  -- / 'specialist_run' / 'morning_brief' / 'music_played'
  event_type TEXT NOT NULL,
  xp REAL NOT NULL,
  -- どのテーブルの何 id に紐付くか (重複防止 + 後追い調査用)。NULL も許容。
  ref_table TEXT,
  ref_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一ソースイベントから 2 度 XP を積まないための部分 unique index。
-- ref_id が NULL の行 (ad-hoc な加算) は対象外で複数許容。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_xp_events_source
  ON xp_events (event_type, ref_table, ref_id)
  WHERE ref_id IS NOT NULL;

-- 累計 SUM を毎回スキャンする想定なので created_at の index は最低限。
CREATE INDEX IF NOT EXISTS idx_xp_events_created
  ON xp_events (created_at DESC);
