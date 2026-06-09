-- notification_settings: 3 値 mode_* enum を toast_* / speak_* 2 軸 boolean に分解
-- 設計: docs/notification-system.md §10.2
--
-- 旧 (v1): mode_online / mode_away / mode_focus (TEXT: "speak"|"notify"|"silent")
-- 新 (v2): toast_* + speak_* (BOOLEAN x 6 列)
-- 変換ルール:
--   speak  → toast=true,  speak=true
--   notify → toast=true,  speak=false
--   silent → toast=false, speak=false
--
-- mode_* は当面残す (= F5 で別途 drop)。compat 期間中の rollback / 後方互換のため。

ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS toast_online BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS speak_online BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS toast_away   BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS speak_away   BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS toast_focus  BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS speak_focus  BOOLEAN;

-- 既存 mode_* 列から変換 (= NULL の行だけ埋める、再適用安全)
UPDATE notification_settings SET
  toast_online = (mode_online IN ('speak', 'notify')),
  speak_online = (mode_online = 'speak'),
  toast_away   = (mode_away   IN ('speak', 'notify')),
  speak_away   = (mode_away   = 'speak'),
  toast_focus  = (mode_focus  IN ('speak', 'notify')),
  speak_focus  = (mode_focus  = 'speak')
WHERE toast_online IS NULL;

-- 全行が値を持つことを確認してから NOT NULL 化
ALTER TABLE notification_settings ALTER COLUMN toast_online SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN speak_online SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN toast_away   SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN speak_away   SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN toast_focus  SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN speak_focus  SET NOT NULL;
