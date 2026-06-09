-- メール仕分け学習システム Phase 1
-- 設計: docs/mail-classification.md
--
-- 1) mail_training_examples: user 手動ラベルの蓄積 (RAG ソース)
-- 2) mail_messages に bucket 関連 4 列追加 (既存 score / score_reason と並行運用)

CREATE TABLE IF NOT EXISTS mail_training_examples (
  id              BIGSERIAL PRIMARY KEY,
  source_mail_id  BIGINT REFERENCES mail_messages(id) ON DELETE SET NULL,
  embedding       VECTOR(1024) NOT NULL,
  embedded_text   TEXT NOT NULL,
  bucket          TEXT NOT NULL CHECK (bucket IN ('important', 'needed', 'unneeded')),
  hint_text       TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mail_training_examples_embedding
  ON mail_training_examples USING hnsw (embedding vector_cosine_ops);

CREATE INDEX IF NOT EXISTS idx_mail_training_examples_source
  ON mail_training_examples (source_mail_id);

ALTER TABLE mail_messages
  ADD COLUMN IF NOT EXISTS bucket            TEXT
    CHECK (bucket IN ('important', 'needed', 'unneeded')),
  ADD COLUMN IF NOT EXISTS bucket_confidence REAL,
  ADD COLUMN IF NOT EXISTS bucket_reason     TEXT,
  ADD COLUMN IF NOT EXISTS classified_at     TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_mail_messages_bucket
  ON mail_messages (bucket) WHERE bucket IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_mail_messages_classified_at
  ON mail_messages (classified_at);
