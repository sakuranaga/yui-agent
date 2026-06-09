-- VRM モデル (秘書のお着替え) スキーマ
-- Phase 1: 複数モデル登録 + 手動切替。スケジュール自動切替は Phase 3 で別 migration。
-- 設計: docs/vrm-wardrobe.md (未作成、まずはコードと並走)

CREATE TABLE vrm_models (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  filename           TEXT NOT NULL UNIQUE,         -- 物理保存名 (例: "12.vrm")。実体は data/vrm-models/<filename>
  thumbnail_filename TEXT,                          -- 同 dir に "<id>.thumb.png"。未生成なら NULL
  file_size_bytes    BIGINT NOT NULL,
  is_default         BOOLEAN NOT NULL DEFAULT false, -- どれか 1 つを default にする運用 (起動時 / current 未設定時にこれを採用)
  enabled            BOOLEAN NOT NULL DEFAULT true,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_vrm_models_enabled ON vrm_models (id) WHERE enabled = true;

CREATE TABLE vrm_settings (
  id                       INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  current_model_id         BIGINT REFERENCES vrm_models(id) ON DELETE SET NULL,
  -- 手動 override (auto schedule が Phase 3 で入った時、これが NULL でない間は schedule 無視)
  manual_override_model_id BIGINT REFERENCES vrm_models(id) ON DELETE SET NULL,
  auto_switch_enabled      BOOLEAN NOT NULL DEFAULT false,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO vrm_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
