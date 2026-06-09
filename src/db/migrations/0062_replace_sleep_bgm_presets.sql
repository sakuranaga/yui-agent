-- 配布用 preset BGM を Adobe Stock (= 再配布不可) から CC BY 3.0/4.0 (= 商用 OK、
-- attribution 必須) の Chosic 由来 5 曲に差し替える。
--
-- ファイル本体は public/sleep-bgm/bgm_*.mp3 に配置済。
-- ライセンス本文は public/sleep-bgm/credits/*.txt に同梱、CREDITS-AUDIO.md に
-- 集約クレジット表記を置く。
--
-- 注意: 既存 legacy preset row (= is_uploaded=false) は全部削除する。
-- user upload (= is_uploaded=true) には触らない。

DELETE FROM sleep_bgm WHERE is_uploaded = false;

INSERT INTO sleep_bgm (title, filename, duration_sec, enabled, is_uploaded) VALUES
  ('Sunset Landscape',       'bgm_sunset_landscape.mp3', NULL, true, false),
  ('Spa Relax',              'bgm_spa_relax.mp3',        NULL, true, false),
  ('Spatium (Calm Ambient)', 'bgm_spatium.mp3',          NULL, true, false),
  ('Reverie',                'bgm_reverie.mp3',          NULL, true, false),
  ('MANTRA',                 'bgm_mantra.mp3',           NULL, true, false);
