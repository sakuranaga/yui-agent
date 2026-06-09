-- 発火時に Yui に実行させる任意のプロンプト。
-- 例:
--   「1分後にポップスかけて」 → on_fire_prompt='ポップスかけて'
--   「明日6時にニュース」      → on_fire_prompt='今日のニュース教えて'
--   「5分タイマー」            → on_fire_prompt=NULL (通知だけ)
-- fireNow が NULL でなければ内部で /api/chat に POST して Yui に実行させる。
ALTER TABLE timers ADD COLUMN IF NOT EXISTS on_fire_prompt TEXT;
