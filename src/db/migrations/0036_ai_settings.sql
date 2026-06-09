-- AI 設定 (key-value, シングルユーザー)
-- 設計: docs/ai-settings.md
--
-- 既存 .env から段階的に DB 優先に移行する。caller は getAiSetting(key)
-- 経由で読み、DB → env → ハードコードデフォルトの順にフォールバック。

CREATE TABLE ai_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  is_secret   BOOLEAN NOT NULL DEFAULT false,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
