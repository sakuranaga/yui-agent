-- ツール重複実行ガードの実行ログ (reservation)。設計: docs/tool-dedup-and-adding-tools.md。
--
-- mutation/外部送信を runTool 共通層で記録し、会話ターンをまたぐ重複 (過去依頼の再実行・
-- 文字違いの同一予定) を防ぐ。判定は同 scope+tool+anchor を時間窓で粗絞り → title embedding 類似で精査。
-- status で auto 実行中/confirm 待ち/完了 を区別し race と確認待ち重複を防ぐ。

CREATE TABLE IF NOT EXISTS tool_execution_log (
  id                    BIGSERIAL PRIMARY KEY,
  scope_key             TEXT NOT NULL,                 -- 実体単位 (calendar:<id> / session:<id>)
  tool_name             TEXT NOT NULL,
  dedup_anchor          TEXT NOT NULL,                 -- null は '__null__' に正規化
  title_text            TEXT NOT NULL DEFAULT '',
  title_embedding       vector(1024),                  -- dedup 対象は予約時に毎回 set
  embedding_model       TEXT,                          -- 異モデルのベクトル比較を防ぐ
  embedding_dimensions  INT,
  status                TEXT NOT NULL
                          CHECK (status IN ('executing','pending_confirmation','executed','skipped','failed','cancelled')),
  confirm_token         TEXT,                          -- confirm 経路の reservation を紐付け
  args                  JSONB,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 衝突判定の粗絞り (scope+tool+anchor を時間窓で引く)
CREATE INDEX IF NOT EXISTS idx_tool_exec_lookup
  ON tool_execution_log (scope_key, tool_name, dedup_anchor, created_at DESC);

-- confirm_token で executePendingTool が該当行を特定 (unique、NULL は除外)
CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_exec_confirm_token
  ON tool_execution_log (confirm_token) WHERE confirm_token IS NOT NULL;

-- cleanup (24h 超を削除) 用
CREATE INDEX IF NOT EXISTS idx_tool_exec_created ON tool_execution_log (created_at);
-- HNSW は張らない: scope+tool+anchor+窓 で粗絞りした少数行に対し embedding 比較するため不要。
