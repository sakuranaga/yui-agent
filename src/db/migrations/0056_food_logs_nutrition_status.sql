-- 食事ログ抽出 v2 (= Gemma 即時抽出 + Haiku 並列 nutrition fill) のための status 列。
-- pending: extractor が INSERT したばかり、kcal/PFC 未充足 (worker が後続で埋める)
-- done:    kcal/PFC 充足済 (旧 extractor 経路の既存ロウも含む = default)
-- manual_user: user が会話で kcal/PFC を明示申告した → worker は触らない
-- failed:  worker が lookup を試みたが取得できなかった
ALTER TABLE food_logs
  ADD COLUMN nutrition_status text NOT NULL DEFAULT 'done';

-- pending 行を worker が拾うための partial index
CREATE INDEX IF NOT EXISTS idx_food_logs_nutrition_status_pending
  ON food_logs (created_at)
  WHERE nutrition_status = 'pending';
