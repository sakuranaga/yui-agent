-- current_mode に 'auto' を追加 (default も 'auto' に変更)。
-- 'auto' = Yui が会話の文脈で自動的に work/relax を切り替える
-- 'work' / 'relax' = ユーザーが明示的に固定

ALTER TABLE persona_settings DROP CONSTRAINT IF EXISTS persona_settings_current_mode_check;
ALTER TABLE persona_settings
  ADD CONSTRAINT persona_settings_current_mode_check
  CHECK (current_mode IN ('auto', 'work', 'relax'));

ALTER TABLE persona_settings ALTER COLUMN current_mode SET DEFAULT 'auto';

-- 既存 row が 'work' (= 旧 default) のままなら 'auto' に更新
UPDATE persona_settings SET current_mode = 'auto' WHERE current_mode = 'work' AND updated_at = (SELECT MIN(updated_at) FROM persona_settings);
