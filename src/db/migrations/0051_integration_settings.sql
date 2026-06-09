-- 外部連携用の汎用 key/value (Maps API key 等、API key 系を DB 保管したい用途向け)。
-- ai_settings は AI 専用、これは「AI 以外の外部 API 連携」用の同等テーブル。

CREATE TABLE IF NOT EXISTS integration_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
