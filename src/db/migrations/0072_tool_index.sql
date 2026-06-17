-- ツール検索 (Executor #2 の候補絞り込み) 用インデックス。
-- 設計: docs/tool-dispatch-redesign.md §12.2 / §12.4。
--
-- dense (pgvector cosine) + lexical (PGroonga 日本語全文検索) のハイブリッドで
-- 各ツールの「例文 + description」を検索し候補を ~10 に絞る。
-- PG18 image (Dockerfile.postgres) で pgvector + PGroonga が利用可能。

-- 日本語 lexical を正しく動かすための PGroonga 拡張 (記憶システム §I1 の simple tsvector 問題の解)
CREATE EXTENSION IF NOT EXISTS pgroonga;

CREATE TABLE IF NOT EXISTS tool_index (
  id                    BIGSERIAL PRIMARY KEY,
  tool_name             TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('example', 'description')),
  text                  TEXT NOT NULL,            -- 元テキスト (再 embed の正本)
  embedding             vector(1024) NOT NULL,    -- dense (bge-m3、現行 embed モデル)
  embedding_model       TEXT NOT NULL,            -- この行を embed したモデル ID (stale 検知)
  embedding_dimensions  INT  NOT NULL,            -- 次元 (次元不一致検知)
  index_version         TEXT NOT NULL,            -- atomic 再構築用 (active は tool_index_meta)
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 同一 (tool, kind, テキスト, version) の重複防止。text_hash 列は持たず式 index で。
CREATE UNIQUE INDEX IF NOT EXISTS uq_tool_index_row
  ON tool_index (tool_name, kind, md5(text), index_version);

-- version ごとの引き込み用
CREATE INDEX IF NOT EXISTS idx_tool_index_version ON tool_index (index_version);

-- dense: ベクトル検索 (既存 note_chunks/memory_chunks と同じ HNSW パラメータ)。
-- HNSW は embedding 全体に張られるので、検索時に WHERE index_version = active で絞る。
-- 旧 version 行が大量に残ると active 行の近傍 recall が劣化しうる (Codex Medium) →
-- reindex job は active 切替後に旧 version を速やかに削除する (§12.4)。
CREATE INDEX IF NOT EXISTS idx_tool_index_embedding
  ON tool_index USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- lexical: 日本語全文検索 (PGroonga)。tokenizer は recall eval で TokenMecab /
-- TokenBigram / TokenNgram から確定する想定 (§12.2)。初期候補 = TokenMecab。
-- eval で別 tokenizer が勝った場合は後続 migration で DROP/CREATE して差し替える。
CREATE INDEX IF NOT EXISTS idx_tool_index_text_pgroonga
  ON tool_index USING pgroonga (text)
  WITH (tokenizer = 'TokenMecab');

-- メタ (active_tool_index_version 等)。クエリは active version の行だけを見る。
-- 初期 active row は seed しない → 初回 build が完了するまで active version 無し =
-- 検索実装側は「active 無し = full permitted catalog fallback」として扱う (§12.2)。
CREATE TABLE IF NOT EXISTS tool_index_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
