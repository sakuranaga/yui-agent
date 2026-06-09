-- Artifact links (source → target、ポリモーフィック M:N)
-- intent dispatch (mail → todo / event → todo / etc) で作成された target が、
-- どの source から生まれたかを back-link で辿れるようにする。
--
-- 設計: docs/roadmap.md §6.9 (intent endpoint Phase B)
-- project_links と同じ哲学: polymorphic + JSDoc 仕様書、新ツール追加で
-- テーブル変更不要。

CREATE TABLE artifact_links (
  source_type TEXT NOT NULL,     -- "mail" | "event" | "todo" | "contact" | "diary"
  source_id   TEXT NOT NULL,
  target_type TEXT NOT NULL,     -- "todo" | "event" | "contact" | "memo"
  target_id   TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by  TEXT NOT NULL DEFAULT 'intent',  -- "intent" | "manual"
  PRIMARY KEY (source_type, source_id, target_type, target_id)
);

-- target -> source 引き (TODO 詳細で「出典」を表示)
CREATE INDEX idx_artifact_links_target ON artifact_links (target_type, target_id);
-- source -> target 引き (Mail 詳細で「ここから作られた TODO 一覧」)
CREATE INDEX idx_artifact_links_source ON artifact_links (source_type, source_id);
