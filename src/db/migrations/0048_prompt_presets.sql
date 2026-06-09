-- 追加プロンプト プリセット
-- 設定 > 秘書 tab から「ペルソナ基本は触らず、追加で渡したい指示」を複数登録し、
-- 1 つだけ有効化 (or なし) できる。buildYuiSystemPrompt が persona に追記。

CREATE TABLE IF NOT EXISTS prompt_presets (
  id          BIGSERIAL PRIMARY KEY,
  label       TEXT NOT NULL,
  body        TEXT NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE persona_settings
  ADD COLUMN IF NOT EXISTS active_prompt_preset_id BIGINT REFERENCES prompt_presets(id) ON DELETE SET NULL;
