-- Yui ノート空間 (= 知識/メモ層、docs/yui-notes.md Phase N1)。
-- markdown ノート + 本文 chunk 分割 embedding による意味検索。
-- memory_chunks (= 会話記憶) とは別系統 (= 自動 recall に混ぜない)。

CREATE TABLE IF NOT EXISTS notes (
  id          BIGSERIAL PRIMARY KEY,
  title       TEXT NOT NULL DEFAULT '',          -- 空なら本文先頭から自動生成
  body_md     TEXT NOT NULL,                      -- markdown 本文
  -- 出所。'human'|'doc_agent'|'deep_research'|'mcp'|'tool_report'|'project_note'
  source      TEXT NOT NULL DEFAULT 'human',
  -- project 紐付けは bespoke FK ではなく既存 project_links (M:N, artifact_type='memo') を使う
  -- (docs/yui-notes.md §14.2)。よって notes 側に project_id 列は持たない。
  pinned      BOOLEAN NOT NULL DEFAULT FALSE,
  archived    BOOLEAN NOT NULL DEFAULT FALSE,     -- ソフトデリート
  source_meta JSONB,                              -- {model, jobId, mcpClient 等}
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notes_created ON notes (created_at DESC) WHERE NOT archived;
CREATE INDEX IF NOT EXISTS idx_notes_source  ON notes (source)          WHERE NOT archived;
-- 全文検索 (= body_md 全体。日本語は simple config、memory_chunks と同じ方式)
CREATE INDEX IF NOT EXISTS idx_notes_fts
  ON notes USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || body_md));

-- 意味検索の本体。embed() は入力を 1500 字で hard cap するので本文を chunk 分割して embed する。
CREATE TABLE IF NOT EXISTS note_chunks (
  id          BIGSERIAL PRIMARY KEY,
  note_id     BIGINT NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  chunk_index INT NOT NULL,                       -- ノート内の順序
  content     TEXT NOT NULL,                      -- chunk 本文 (~1000 字目安)
  embedding   vector(1024) NOT NULL,              -- 1024 固定 (= 現行 embed モデル前提)
  UNIQUE (note_id, chunk_index)
);

CREATE INDEX IF NOT EXISTS idx_note_chunks_note ON note_chunks (note_id);
-- ベクトル検索。既存 memory_chunks (0000_initial.sql) と同じ HNSW パラメータに揃える。
CREATE INDEX IF NOT EXISTS idx_note_chunks_embedding
  ON note_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
