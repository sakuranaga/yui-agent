-- sleep_bgm に is_uploaded 列を追加。
--
-- 既存 row (= public/sleep-bgm/*.mp3 を指す legacy preset) は is_uploaded=false。
-- 新規 upload は is_uploaded=true、ファイル本体は data/sleep-bgm/{id}.mp3 に保存し、
-- API stream 配信 (= /api/sleep/bgm/{id}/file) する。
--
-- 配信 URL の振り分け (= GET /api/sleep/bgm の list 応答で実施):
--   is_uploaded=false → /sleep-bgm/{filename}               (= 静的、public 配下)
--   is_uploaded=true  → /api/sleep/bgm/{id}/file            (= stream、data 配下)
--
-- OSS 公開時、Adobe Stock の既存 preset を削除して CC0 代替に差し替える際は、
-- DB 上の legacy row を delete + public ファイルも削除する別 migration を実行する。

ALTER TABLE sleep_bgm
  ADD COLUMN is_uploaded BOOLEAN NOT NULL DEFAULT FALSE;
