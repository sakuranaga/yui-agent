-- memory_chunks に owner カラム追加。
-- 設計: docs/memory-architecture.md §16.7 Phase 1
--
-- 値:
--   'user'      — ご主人様の事実 / 嗜好
--   'assistant' — 秘書ペルソナの設定 (結衣 等、persona で可変なので汎用名)
--   'shared'    — 両者に関する事実 (共通体験、関係性 等)
--
-- 既存行は一律 'user' でバックフィル (大半はユーザー嗜好、結衣ペルソナ混入分は
-- 後日 reconcile / 手動編集 UI で訂正してもらう前提)。

ALTER TABLE memory_chunks
  ADD COLUMN owner TEXT NOT NULL DEFAULT 'user'
    CHECK (owner IN ('user', 'assistant', 'shared'));

CREATE INDEX idx_memory_chunks_owner ON memory_chunks (owner)
  WHERE invalidated_at IS NULL;
