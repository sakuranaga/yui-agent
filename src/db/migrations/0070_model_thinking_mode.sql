-- モデル別の思考 (thinking) モード設定 (docs/model-config-overhaul.md #206 §8.9)。
-- ローカル推論モデル (Qwen3.6 等) の thinking を entry 単位で ON/OFF 切替可能にする。
--   'auto' = tier ベース (§8.8: sub→抑制 / main・heavy→サーバ既定)
--   'on'   = 常時思考 (enable_thinking:true 強制)
--   'off'  = 常時抑制 (enable_thinking:false、速度優先)
-- local_openai のみ runtime で使用 (hosted は別系統で無視)。

ALTER TABLE model_registry
  ADD COLUMN IF NOT EXISTS thinking_mode TEXT NOT NULL DEFAULT 'auto';

-- 壊れた値の混入を防ぐ (PATCH validation に加えた多層防御)。
ALTER TABLE model_registry
  DROP CONSTRAINT IF EXISTS model_registry_thinking_mode_chk;
ALTER TABLE model_registry
  ADD CONSTRAINT model_registry_thinking_mode_chk
  CHECK (thinking_mode IN ('auto', 'on', 'off'));
