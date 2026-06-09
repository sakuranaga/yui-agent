-- OAuth トークンの at-rest 暗号化 (= Google / Spotify の refresh token)。
-- 旧 plaintext 列はそのまま残し、新規 encrypted_* 列を NULL 可で追加。
-- アプリ startup で「encrypted_* が NULL かつ plaintext が NOT NULL」な行を発見したら
-- ENCRYPTION_KEY で暗号化して新列に書き、plaintext 列を NULL に migrate する。
-- 完全移行後 (= 全 row が encrypted) に旧列を DROP する migration を別途打つ。
--
-- plaintext refresh_token は旧 schema で NOT NULL だったが、暗号化後に NULL 化したいので
-- 制約を外す (= encrypted_refresh_token があれば plaintext は NULL になる)。

ALTER TABLE google_oauth_tokens
  ADD COLUMN encrypted_access_token TEXT,
  ADD COLUMN encrypted_refresh_token TEXT,
  ALTER COLUMN refresh_token DROP NOT NULL;

ALTER TABLE spotify_oauth_tokens
  ADD COLUMN encrypted_access_token TEXT,
  ADD COLUMN encrypted_refresh_token TEXT,
  ALTER COLUMN refresh_token DROP NOT NULL;
