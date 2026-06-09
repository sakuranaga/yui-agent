-- ご主人様がチャットに添付した画像のメタ情報を raw_messages に紐づける。
-- 実体は data/chat-images/<sessionId>/<uuid>.webp に保存し、
-- このカラムには [{filename, mediaType}, ...] の参照のみ持つ。
-- 古い添付は新規アップロード時に keep-last-N でファイルだけ自動削除
-- (raw_messages の行自体は memory 抽出のため残す)。
ALTER TABLE raw_messages
  ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'::jsonb;
