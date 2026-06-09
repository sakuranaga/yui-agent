-- food_logs / workout_logs の raw_text 完全一致 dedup を index 化する。
--
-- food-extract.ts / workout-extract.ts は post-turn で
--   SELECT id FROM food_logs WHERE raw_text = $1 LIMIT 1
-- 形の dedup クエリを毎ターン投げる (= LLM が同じ食事を重複抽出した時の最終保険)。
-- index が無いと 行数に比例して seq scan、長期使用で chat ターンが体感的に遅くなる。
--
-- raw_text は extractor 側で 80 char に slice 済みなので btree の page limit (2704 byte)
-- には収まる。仮に将来 80 chars を超える書き込みが入っても、index 側の page limit 違反は
-- INSERT が落ちるだけで参照側は壊れない (= 検知できる)。

CREATE INDEX IF NOT EXISTS idx_food_logs_raw_text
  ON food_logs (raw_text);

-- workout は raw_text + performed_at の AND 条件で引くので複合 index にする。
-- これで「同じ言及が直近 3h 以内に既出か」のチェックが O(log n) で完了する。
CREATE INDEX IF NOT EXISTS idx_workout_logs_raw_text_performed_at
  ON workout_logs (raw_text, performed_at);
