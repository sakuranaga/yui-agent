-- Project links (M:N、polymorphic): プロジェクトと各種アーティファクト
-- (todo / mail / event / contact / 将来 memo 等) を 1 テーブルで紐付け管理。
--
-- 設計: docs/roadmap.md §6.8 (これから書く)
--
-- 拡張性:
--   新アーティファクト種を増やす時は、artifact_type の文字列値に
--   "memo" 等を追加するだけで OK。テーブル変更不要。
--   外部 FK 整合性は犠牲にする代わりに拡張容易性を取る (個人用 + cleanup job
--   で orphan を掃除する想定)。intent endpoint と同じポリモーフィック哲学。
--
-- 既存 todos.project_id (1:N 主従) は primary project として残す。
-- M:N の追加リンクは project_links に書く。後追いで完全移行も可能。

CREATE TABLE project_links (
  project_id    BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  artifact_type TEXT NOT NULL,    -- "todo" | "mail" | "event" | "contact" | "memo"
  artifact_id   TEXT NOT NULL,    -- 各テーブルの id を string 化 (mail は gmail msg id 等の自由文字列もあり得るため統一)
  linked_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  linked_by     TEXT NOT NULL DEFAULT 'manual',  -- "manual" | "ai" | "intent" | "primary" (todos.project_id 由来の擬似行)
  PRIMARY KEY (project_id, artifact_type, artifact_id)
);

-- artifact -> projects 引き (連絡先カード等で「この人が紐付いてる project 一覧」を出す)
CREATE INDEX idx_project_links_artifact ON project_links (artifact_type, artifact_id);
-- project -> artifacts 引き (Hub dashboard で project 全アーティファクトを引く)
CREATE INDEX idx_project_links_project_type ON project_links (project_id, artifact_type);

-- 既存 todos.project_id のデータを project_links にも複写 (M:N の primary entry として可視化)
INSERT INTO project_links (project_id, artifact_type, artifact_id, linked_by, linked_at)
SELECT t.project_id, 'todo', t.id::text, 'primary', COALESCE(t.created_at, NOW())
FROM todos t
WHERE t.project_id IS NOT NULL
ON CONFLICT DO NOTHING;
