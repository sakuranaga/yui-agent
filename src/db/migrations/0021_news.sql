-- ニュース機能 (Level 3 個人秘書 brief 用)。
-- - news_sources: 取得対象の RSS フィード一覧 (ユーザが UI で追加/削除可)
-- - news_articles: 取得済み記事の cache。published_at が 3 日より古いものは
--   pinned=false なら periodic で auto delete。pinned=true は永続。

CREATE TABLE IF NOT EXISTS news_sources (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_news_sources_enabled
  ON news_sources (enabled, name);

CREATE TABLE IF NOT EXISTS news_articles (
  id BIGSERIAL PRIMARY KEY,
  source_id BIGINT NOT NULL REFERENCES news_sources(id) ON DELETE CASCADE,
  guid TEXT NOT NULL,                 -- RSS の guid (or link が一意鍵)
  title TEXT NOT NULL,
  link TEXT,
  summary TEXT,
  published_at TIMESTAMPTZ NOT NULL,  -- フィード上の公開時刻
  fetched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  pinned BOOLEAN NOT NULL DEFAULT FALSE,
  pinned_at TIMESTAMPTZ,
  UNIQUE (source_id, guid)
);
-- 一覧 (新着順): pinned=true を先頭固定したいので app 側で OR で sort、
-- ここでは published_at desc index で十分。
CREATE INDEX IF NOT EXISTS idx_news_articles_published
  ON news_articles (published_at DESC);
-- source 別の一覧用
CREATE INDEX IF NOT EXISTS idx_news_articles_source_published
  ON news_articles (source_id, published_at DESC);
-- TTL クリーンアップで scan する partial index (pinned=false のみ対象)
CREATE INDEX IF NOT EXISTS idx_news_articles_ttl
  ON news_articles (published_at)
  WHERE pinned = FALSE;
-- pinned 検索用
CREATE INDEX IF NOT EXISTS idx_news_articles_pinned
  ON news_articles (pinned_at DESC NULLS LAST)
  WHERE pinned = TRUE;

-- デフォルト 6 sources を seed (idempotent)。
-- ユーザが UI で削除したら再投入されないよう migration で 1 回だけ走らせる。
INSERT INTO news_sources (name, url, enabled) VALUES
  ('NHK NEWS WEB',  'https://www3.nhk.or.jp/rss/news/cat0.xml',                  TRUE),
  ('朝日新聞',      'https://www.asahi.com/rss/asahi/newsheadlines.rdf',         TRUE),
  ('ITmedia NEWS',  'https://rss.itmedia.co.jp/rss/2.0/news_bursts.xml',         TRUE),
  ('Gigazine',      'https://gigazine.net/news/rss_2.0/',                        TRUE),
  ('Hacker News',   'https://hnrss.org/frontpage',                               TRUE),
  ('共同通信',      'https://www.kyodo.co.jp/feed/',                             TRUE)
ON CONFLICT (url) DO NOTHING;
