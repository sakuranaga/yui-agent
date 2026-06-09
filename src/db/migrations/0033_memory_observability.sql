-- 記憶層の観測性 + decay インフラ
-- 設計: docs/memory-architecture.md §16.7 Phase 5/7/8

-- retrieval_log: 「いつどの chunk が retrieval で使われたか」を append-only で記録
-- decay 判定 (最終参照時刻) + 利用統計 + 監査トレイル用
CREATE TABLE retrieval_log (
  id BIGSERIAL PRIMARY KEY,
  chunk_id BIGINT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  session_id TEXT,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  layer TEXT NOT NULL,        -- 'l2_facts' | 'l3_summary' | 'l4_semantic' | 'reconcile' | 'extract_dedup'
  rank INT,                    -- 0-based 順位 (layer 内の)
  score REAL                   -- cosine sim or importance score
);
CREATE INDEX idx_retrieval_log_chunk_recent
  ON retrieval_log (chunk_id, retrieved_at DESC);
CREATE INDEX idx_retrieval_log_recent
  ON retrieval_log (retrieved_at DESC);

-- decay_runs: 日次 decay ジョブの監視ログ
CREATE TABLE decay_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed INT NOT NULL,             -- 評価した chunk 数
  decayed INT NOT NULL,               -- importance を下げた数
  invalidated INT NOT NULL,           -- importance < 0.05 で auto invalidate された数
  errors INT NOT NULL DEFAULT 0,
  duration_ms INT,
  details JSONB                        -- 分布ヒストグラム等
);
CREATE INDEX idx_decay_runs_recent ON decay_runs (ran_at DESC);
