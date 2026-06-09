-- timers.kind の "reminder" を "alarm" にリネーム。
--
-- 背景: 新規 "リマインダー" 機能 (繰り返し / TODO/予定 紐付け / 習慣) を導入する
-- にあたり、現状 timers が担っていた「タイマー (相対) + リマインダー (絶対時刻)」
-- のうち後者を「アラーム」に語彙統一する。これで:
--   - timers.kind='timer'  → タイマー (相対秒数)
--   - timers.kind='alarm'  → アラーム (絶対時刻、Yui 起動可)
--   - reminders (新規テーブル) → リマインダー (繰り返し / 紐付き)
-- がきれいに分かれる。

ALTER TABLE timers DROP CONSTRAINT IF EXISTS timers_kind_check;

UPDATE timers SET kind = 'alarm' WHERE kind = 'reminder';

ALTER TABLE timers
  ADD CONSTRAINT timers_kind_check CHECK (kind IN ('timer','alarm'));
