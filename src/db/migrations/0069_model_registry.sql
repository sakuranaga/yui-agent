-- モデルレジストリ (docs/model-config-overhaul.md #206 M1)。
-- hosted / ローカルの LLM モデルを複数登録する。3 tier (main/sub/heavy) への割当と
-- fallback は ai_settings KV (model_tier_assignment / model_tier_fallback / role_tier_overrides)
-- に JSON で持つ (= 点在する少数の値なので専用列にしない)。
-- provider は明示保持 (= prefix 推定をやめ、ローカルも router の一級 provider にする)。

CREATE TABLE IF NOT EXISTS model_registry (
  id            TEXT PRIMARY KEY,                 -- アプリ生成 (uuid)
  label         TEXT NOT NULL,                    -- 表示名
  provider      TEXT NOT NULL,                    -- anthropic|openai|gemini|grok|local_openai
  model_id      TEXT NOT NULL,                    -- 各 provider の model 名
  base_url      TEXT,                             -- local_openai 時必須 (OpenAI 互換 base、例 http://llm:8081/v1)
  api_key_ref   TEXT,                             -- anthropic|openai|gemini|grok|NULL (= 暗号化済 ai_settings のキーを参照)
  capabilities  JSONB NOT NULL DEFAULT '{}'::jsonb, -- { reachable, supportsTools, testedAt, lastError } (camelCase = 既存 JSONB 慣習に合わせる、例 ReminderSchedule)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS model_registry_provider_idx ON model_registry (provider);
