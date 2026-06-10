-- tts_dictionary に source 列を追加 (= エントリの出所を区別)。
-- TTS 辞書 v2 / 英→カタカナ一括辞書 (docs/tts-dictionary-v2.md) のための拡張。
--
--   'user'    : ご主人様の手動登録 / Yui のツール登録 (= 最優先、bulk import で上書きしない)
--   'preset'  : 初期 seed (tts-dictionary-preset)
--   'cmudict' : e2k で一括生成した英→カタカナ辞書 (13 万件規模、一括 disable/再生成/削除の対象)
--
-- 既存行はすべて 'user' 扱いにして保護する (= 現時点で preset と user を確実に区別できない
-- ため、安全側に倒して「ユーザ所有」とみなし、bulk import で絶対に上書きさせない)。
ALTER TABLE tts_dictionary
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'user';

-- 大量エントリ (cmudict) の一括操作 / フィルタ用 index。
CREATE INDEX IF NOT EXISTS idx_tts_dictionary_source ON tts_dictionary (source);

-- 大文字小文字を区別しない前方一致検索を 13 万件規模で高速化する index。
-- `lower(word) LIKE 'prefix%'` (= 検索 API の ASCII クエリ経路) が index を使えるよう、
-- lower(word) の text_pattern_ops index を張る (= LIKE のパターンマッチで btree を使う条件)。
CREATE INDEX IF NOT EXISTS idx_tts_dictionary_lower_word
  ON tts_dictionary (lower(word) text_pattern_ops);
