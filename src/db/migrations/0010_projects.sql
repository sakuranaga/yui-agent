-- 上位作業コンテナ。Plane の project に相当 (1 ユーザー、自由作成)。
CREATE TABLE IF NOT EXISTS projects (
  id BIGSERIAL PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  color TEXT,
  description TEXT,
  -- project レベルの Gantt 用 (子 task の min/max でなく、project 自体の予定)
  start_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  -- Plane からインポートした行を識別するため (将来再インポート防止に使用可能)
  external_ref TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_projects_archived_sort
  ON projects (archived, sort_order, name);
