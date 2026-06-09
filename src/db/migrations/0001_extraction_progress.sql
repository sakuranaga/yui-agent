-- Phase 3 (前倒し): rolling extraction の進捗追跡。
-- 各セッションごとに「どの raw_messages.id まで抽出済みか」を保持し、
-- rolling と session-end の両方が重複抽出しないようにする。
-- 詳細は docs/memory-architecture.md §5.3 参照。

CREATE TABLE IF NOT EXISTS extraction_progress (
  session_id                 TEXT PRIMARY KEY,
  last_extracted_message_id  BIGINT NOT NULL DEFAULT 0,
  last_extracted_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
