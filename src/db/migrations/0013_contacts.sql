-- 連絡先 / 人物録。Yui が "青山さんって誰" 等の質問に答えるための内部 CRM。
-- notes は markdown 自由テキストで、Yui が会った日 / 内容 / 関係性メモを
-- 上から積み重ねていく (## 2026-05-26 形式の単純な append が想定運用)。
CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  identifier TEXT UNIQUE NOT NULL,  -- "C-1", "C-2" 連番
  session_id TEXT NOT NULL,

  name TEXT NOT NULL,
  kana TEXT,                        -- 読み仮名 (検索用)
  company TEXT,
  role TEXT,                        -- 肩書き / 役職
  email TEXT,
  phone TEXT,
  address TEXT,
  birthday DATE,
  tags TEXT[] NOT NULL DEFAULT '{}',
  notes TEXT,                       -- markdown 自由テキスト

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_contact_at TIMESTAMPTZ       -- 最後にメモが追記された時刻 (sort 用)
);

CREATE INDEX IF NOT EXISTS idx_contacts_session ON contacts (session_id);
CREATE INDEX IF NOT EXISTS idx_contacts_last_contact ON contacts (last_contact_at DESC NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_contacts_tags_gin ON contacts USING GIN (tags);
-- 名前 / フリガナ / 会社 ILIKE 検索向け
CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts (lower(name));

CREATE SEQUENCE IF NOT EXISTS contacts_identifier_seq START WITH 1;
