-- Google OAuth tokens (Phase B continuation: GCal + Gmail via official MCP)
--
-- 単一ユーザー Yui 前提。row は基本 1 行 (1 つの Google アカウント)。
-- 複数アカウント対応する時は account_email を unique にして複数 row 持てる。
-- refresh_token は実質永続。access_token は短寿命 (1 時間) のキャッシュ。

CREATE TABLE IF NOT EXISTS google_oauth_tokens (
  id              BIGSERIAL PRIMARY KEY,
  account_email   TEXT NOT NULL UNIQUE,
  scopes          TEXT[] NOT NULL,
  refresh_token   TEXT NOT NULL,
  access_token    TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_google_oauth_tokens_email ON google_oauth_tokens (account_email);
