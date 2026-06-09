-- サイレント時間帯設定 (= 旧 22-7 JST ハードコード置換)
-- 設計: docs/notification-system.md §8.2
--
-- singleton 行 (id=1) で 1 ユーザ運用前提。enabled=false がデフォルト = v1 の
-- 夜間オーバーライドは無効化される (= リリースノートで案内必須)。

CREATE TABLE IF NOT EXISTS quiet_hours_settings (
  id          SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled     BOOLEAN      NOT NULL DEFAULT FALSE,
  start_hour  SMALLINT     NOT NULL DEFAULT 22 CHECK (start_hour BETWEEN 0 AND 23),
  end_hour    SMALLINT     NOT NULL DEFAULT 7  CHECK (end_hour   BETWEEN 0 AND 23),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- singleton 行を必ず 1 行保証 (アプリ側で UPSERT する場合の seed)
INSERT INTO quiet_hours_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
