-- TTS 用語辞書 (Settings の「読み方」タブで CRUD)。
-- /api/tts route の前段で longest-first に文字列置換、Yui の発話 / 日記 /
-- ハート反応 / Apple Music の曲紹介すべてに自動適用される。
-- LLM normalize (Haiku) の前処理としても同じ辞書を使う (docs/roadmap.md §7.8)。

CREATE TABLE IF NOT EXISTS tts_dictionary (
  id BIGSERIAL PRIMARY KEY,
  word TEXT NOT NULL UNIQUE,
  reading TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 並び順は word の長い順で適用するので index は不要 (全件 in-memory cache 前提)。
-- 検索用に簡易 ILIKE index だけ:
CREATE INDEX IF NOT EXISTS idx_tts_dictionary_word ON tts_dictionary (word);

-- 初期 seed (現行ハードコード辞書 38 語)。
INSERT INTO tts_dictionary (word, reading) VALUES
  ('3D', 'スリーディー'),
  ('2D', 'ツーディー'),
  ('AI', 'エーアイ'),
  ('VR', 'ブイアール'),
  ('AR', 'エーアール'),
  ('PC', 'ピーシー'),
  ('OS', 'オーエス'),
  ('iOS', 'アイオーエス'),
  ('URL', 'ユーアールエル'),
  ('API', 'エーピーアイ'),
  ('DB', 'ディービー'),
  ('SQL', 'エスキューエル'),
  ('LLM', 'エルエルエム'),
  ('TTS', 'ティーティーエス'),
  ('VRM', 'ブイアールエム'),
  ('VRMA', 'ブイアールエムエー'),
  ('SaaS', 'サース'),
  ('EC', 'イーシー'),
  ('TODO', 'トゥードゥー'),
  ('ping', 'ピング'),
  ('pong', 'ポン'),
  ('UTC', 'ユーティーシー'),
  ('JST', 'ジェーエスティー'),
  ('AM', 'エーエム'),
  ('PM', 'ピーエム'),
  ('GitHub', 'ギットハブ'),
  ('Apple Music', 'アップルミュージック'),
  ('Discord', 'ディスコード'),
  ('Twitter', 'ツイッター'),
  ('Slack', 'スラック'),
  ('Notion', 'ノーション'),
  ('Google', 'グーグル'),
  ('OpenAI', 'オープンエーアイ'),
  ('Anthropic', 'アンスロピック'),
  ('Claude', 'クロード'),
  ('Sonnet', 'ソネット'),
  ('Haiku', 'ハイク'),
  ('Opus', 'オーパス'),
  ('Yui', 'ゆい'),
  ('feat.', 'フィーチャリング'),
  ('ft.', 'フィーチャリング'),
  ('vs.', 'ブイエス'),
  ('vs', 'ブイエス'),
  ('etc.', 'エトセトラ'),
  ('etc', 'エトセトラ'),
  ('Live', 'ライブ'),
  ('Remastered', 'リマスタード')
ON CONFLICT (word) DO NOTHING;
