-- メール統合システム Phase A: スキーマ
-- 設計: docs/mail-system.md §4
--
-- ポリシー:
-- - Gmail を SoT、自 DB は header + curation 結果 + lazy body (passed のみ)
-- - 削除/既読/スター/重要は自 DB ローカル状態。Gmail には書き戻さない
-- - INSERT は ON CONFLICT DO NOTHING で「自 DB で削除した row」を保護
-- - 添付実体は持たない (metadata のみ、本体は都度 Gmail API から fetch)

-- --- gmail_accounts: メール機能で使う Gmail アカウントの registry ---
-- 既存 google_oauth_tokens (account_email UNIQUE) と email でリンク
CREATE TABLE gmail_accounts (
  id              BIGSERIAL PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  is_primary      BOOLEAN NOT NULL DEFAULT false,   -- 新規作成時の default from
  initial_sync_days INTEGER NOT NULL DEFAULT 3,     -- 初回同期で過去 N 日分を fetch
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at  TIMESTAMPTZ
);

-- is_primary=true は 1 つだけ
CREATE UNIQUE INDEX gmail_accounts_one_primary
  ON gmail_accounts (is_primary) WHERE is_primary = true;

-- --- mail_messages: header + curation + lazy body ---
CREATE TABLE mail_messages (
  id                 BIGSERIAL PRIMARY KEY,
  gmail_message_id   TEXT NOT NULL,
  gmail_thread_id    TEXT NOT NULL,
  account_id         BIGINT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,

  -- header
  from_address       TEXT NOT NULL,
  from_name          TEXT,
  from_email         TEXT NOT NULL,
  to_addresses       TEXT[],
  subject            TEXT,
  snippet            TEXT,
  received_at        TIMESTAMPTZ NOT NULL,
  labels             TEXT[],

  -- curation
  score              REAL,
  score_reason       TEXT,
  curated_at         TIMESTAMPTZ,

  -- 本文 (閾値超え時のみ fetch)
  body_text          TEXT,
  body_html          TEXT,
  body_fetched_at    TIMESTAMPTZ,

  -- アプリローカル状態 (Gmail 非同期)
  read_at            TIMESTAMPTZ,
  starred_at         TIMESTAMPTZ,
  deleted_at         TIMESTAMPTZ,

  inserted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (gmail_message_id, account_id)
);

CREATE INDEX idx_mail_received   ON mail_messages (received_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_mail_score      ON mail_messages (score DESC NULLS LAST)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_mail_thread     ON mail_messages (gmail_thread_id);
CREATE INDEX idx_mail_from_email ON mail_messages (from_email)
  WHERE deleted_at IS NULL;

-- --- mail_attachments: metadata only ---
-- 実体ファイルは自 DB/ディスクに保存しない (セキュリティ + Gmail を SoT として尊重)
-- クリック時に Gmail API から都度 fetch → ブラウザに stream
CREATE TABLE mail_attachments (
  id             BIGSERIAL PRIMARY KEY,
  message_id     BIGINT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  filename       TEXT NOT NULL,
  mime_type      TEXT,
  size_bytes     BIGINT,
  gmail_part_id  TEXT,
  inserted_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_mail_attachments_message ON mail_attachments (message_id);

-- --- mail_curation_settings: singleton ---
-- news_curation_settings と別管理 (メールの「重要さ」は news と判定軸が違う)
CREATE TABLE mail_curation_settings (
  id                 INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  interest_profile   TEXT NOT NULL DEFAULT '',
  score_threshold    REAL NOT NULL DEFAULT 0.5,
  vip_addresses      TEXT[] NOT NULL DEFAULT '{}',
  blocked_addresses  TEXT[] NOT NULL DEFAULT '{}',
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO mail_curation_settings (id, interest_profile)
VALUES (1, '')
ON CONFLICT (id) DO NOTHING;
