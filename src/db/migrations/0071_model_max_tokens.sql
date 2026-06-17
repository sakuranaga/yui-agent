-- モデル別の出力上限 max_tokens (docs/model-config-overhaul.md #206 §8.10)。
-- グローバル env (ANTHROPIC_MAX_TOKENS) では複数モデル混在に合わないため per-entry 列に。
--   ローカル思考モデル (Qwen3.6 等) は思考+回答で大きく (例 32768)、
--   hosted (Claude/OpenAI/Gemini) は非ストリーミング上限以下に設定する。
-- 既定 8192。

ALTER TABLE model_registry
  ADD COLUMN IF NOT EXISTS max_tokens INTEGER NOT NULL DEFAULT 8192;

ALTER TABLE model_registry
  DROP CONSTRAINT IF EXISTS model_registry_max_tokens_chk;
ALTER TABLE model_registry
  ADD CONSTRAINT model_registry_max_tokens_chk
  CHECK (max_tokens > 0 AND max_tokens <= 1048576);
