-- 並行ジョブの atomic claim 用テーブル。
-- 「今日 1 回だけ実行する」系のジョブが setInterval overlap で二重実行されないよう、
-- 「キー (= 日次なら ymd_jst) UNIQUE」の row を INSERT ON CONFLICT DO NOTHING で取り合う。
-- 戻り行が 1 つでも返れば claim 成功、空なら他 tick が先に取った = skip。

CREATE TABLE job_claims (
  -- 例: "memory-decay:2026-06-06" / "morning-check:2026-06-06"
  claim_key TEXT PRIMARY KEY,
  claimed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  module_id TEXT NOT NULL,
  -- 任意のメタ (= 何件処理した等)
  meta JSONB
);

-- 古い claim を掃除する用 (= 1 年以上前を周期 cleanup で消す)
CREATE INDEX idx_job_claims_claimed_at ON job_claims (claimed_at DESC);
