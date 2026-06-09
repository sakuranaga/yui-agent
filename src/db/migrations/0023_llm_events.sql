-- LLM 呼び出しイベントの永続ログ (旧 ./logs/llm.jsonl の DB 化)。
-- 「お給料」(コスト累計 in JPY) や月次集計を SQL で高速に出すため。
-- 既存 jsonl は別途 src/scripts/import-llm-jsonl.ts で 1 回限り移植する想定。

CREATE TABLE IF NOT EXISTS llm_events (
  id BIGSERIAL PRIMARY KEY,
  -- 'call' = 個別 API 呼び出し、'trace' = 1 トレース (= 1 ユーザターン) の集計
  event_type TEXT NOT NULL,
  -- 発生時刻 (epoch ms)。既存 jsonl の ts と互換にするため bigint で保持。
  ts BIGINT NOT NULL,
  -- 'call' 行のみ意味あり
  role TEXT,
  model TEXT,
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  cost_usd REAL,
  duration_ms INTEGER,
  retries INTEGER,
  trace_id TEXT,
  -- 'trace' 行のみ意味あり (call も持つことはあるが集計は trace 行で完結)
  calls INTEGER,
  llm_ms INTEGER,
  wall_ms INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- LogModal の「新しい順 + before カーソル」スクロール用
CREATE INDEX IF NOT EXISTS idx_llm_events_ts ON llm_events (ts DESC);
-- お給料集計 (月次 / 累計) はコスト sum なので type+ts で十分。
CREATE INDEX IF NOT EXISTS idx_llm_events_type_ts ON llm_events (event_type, ts DESC);
-- traceId による合算 (将来必要になったら) 用
CREATE INDEX IF NOT EXISTS idx_llm_events_trace ON llm_events (trace_id) WHERE trace_id IS NOT NULL;
