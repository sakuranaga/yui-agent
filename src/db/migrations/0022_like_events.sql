-- いいね機能: ご主人様が VRM ダブルクリックでハート反応を発火した記録。
-- 将来的には chat bubble 内ハートボタン等でも同じテーブルに積む想定なので、
-- message_id を nullable にして「どの応答への評価か (もしくは null = Yui 自体への撫で)」
-- を吸収できる形にしておく。

CREATE TABLE IF NOT EXISTS like_events (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  -- いいねが向けられた assistant 行の raw_messages.id。
  -- 直前応答 fallback で自動 lookup したが該当無し、もしくは将来 bubble 外 UI なら null。
  message_id BIGINT REFERENCES raw_messages(id) ON DELETE SET NULL,
  -- click 起点座標 (viewport px)。後で「いいね hotspot」可視化に使うかも。
  click_x REAL,
  click_y REAL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 直近いいね判定 (5sec throttle, session 別) のため
CREATE INDEX IF NOT EXISTS idx_like_events_session_created
  ON like_events (session_id, created_at DESC);

-- 「どの応答が一番ハート集めたか」の集計用
CREATE INDEX IF NOT EXISTS idx_like_events_message
  ON like_events (message_id)
  WHERE message_id IS NOT NULL;
