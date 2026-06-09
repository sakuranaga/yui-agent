-- Spotify OAuth tokens (Apple Music からの完全移行)
--
-- 単一 user 前提 (= 常に id=1)。Spotify Connect 経由で他デバイス制御するため
-- Web Playback SDK ではなく Web API のみ使う設計。Free アカウントでも動作する。
--
-- refresh_token は Spotify 側で revoke しない限り永続。
-- access_token は短寿命 (1h) で expires_at まで 60s 切ったら refresh。
-- scope は同意画面で実際に granted された scope を空白区切り文字列で保存。

CREATE TABLE IF NOT EXISTS spotify_oauth_tokens (
  id            INTEGER PRIMARY KEY DEFAULT 1,
  refresh_token TEXT NOT NULL,
  access_token  TEXT,
  expires_at    TIMESTAMPTZ,
  scope         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
