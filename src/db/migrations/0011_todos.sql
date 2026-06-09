-- 統一 todos テーブル (Plane work item + 旧 wishes の役割を吸収)。
-- AI 最適化: identifier ベースで Yui が直接操作、UUID 解決不要。
-- 「タスク」「TODO」「読みたい本」「行きたい店」全部ここ。
-- 既存の "tasks" テーブルは specialist 背景ジョブ用 (リネーム回避のため命名は todos)
CREATE TABLE IF NOT EXISTS todos (
  id BIGSERIAL PRIMARY KEY,
  -- Yui が参照する人間可読 ID。"T-1", "T-2" の連番 (アプリ側で採番)。
  identifier TEXT UNIQUE NOT NULL,
  session_id TEXT NOT NULL,

  project_id BIGINT REFERENCES projects(id) ON DELETE SET NULL,
  -- 自由テキストタグ。複数貼付可。横断フィルタ用 ("本"/"メール"/"買い物"/"緊急" 等)
  tags TEXT[] NOT NULL DEFAULT '{}',

  title TEXT NOT NULL,
  note TEXT,
  url TEXT,

  -- backlog | in_progress | blocked | done
  state TEXT NOT NULL DEFAULT 'backlog',
  -- 1=low, 2=mid (default), 3=high
  priority INTEGER NOT NULL DEFAULT 2,

  -- 登録日 (自動)、開始日 (任意、Gantt 用)、期限 (任意)、完了日 (state=done 遷移時に自動)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  start_at TIMESTAMPTZ,
  due_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Gantt 用の見積もり (任意)
  estimate_hours REAL,

  -- 移行時の Plane 識別子 (例: "WORK-42")。後で WORK-42 で検索可能にするため。null 可。
  external_ref TEXT
);

-- 一覧表示の主軸: 未完了から期限近い順
CREATE INDEX IF NOT EXISTS idx_todos_state_due
  ON todos (state, due_at NULLS LAST, priority DESC, created_at DESC);
-- project 単位
CREATE INDEX IF NOT EXISTS idx_todos_project
  ON todos (project_id, state, due_at);
-- tag 検索 (GIN)
CREATE INDEX IF NOT EXISTS idx_todos_tags_gin
  ON todos USING GIN (tags);
-- external_ref 検索 (Plane 由来の "WORK-42" を引く時)
CREATE INDEX IF NOT EXISTS idx_todos_external_ref
  ON todos (external_ref) WHERE external_ref IS NOT NULL;

-- identifier 連番管理用シーケンス (T-1, T-2, ...)
CREATE SEQUENCE IF NOT EXISTS todos_identifier_seq START WITH 1;
