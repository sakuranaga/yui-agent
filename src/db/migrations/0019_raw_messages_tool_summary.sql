-- assistant メッセージで Yui が実行した tool 呼び出しの要約を残す。
-- 次ターン送信時に apiMessages の assistant content 末尾へ
-- "(内部実行ログ: ...)" として注入し、Sonnet に「過去ターンで何が完了済みか」を
-- 明示する。これで重複 dispatch を構造的に抑止する。
-- フォーマット: [{name: string, brief: string}, ...]
ALTER TABLE raw_messages
  ADD COLUMN IF NOT EXISTS tool_summary JSONB NOT NULL DEFAULT '[]'::jsonb;
