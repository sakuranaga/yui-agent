-- 睡眠サポート (cognitive shuffling) スキーマ
-- 設計: docs/sleep-support.md

CREATE TABLE sleep_categories (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  enabled       BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE sleep_words (
  id          BIGSERIAL PRIMARY KEY,
  category_id BIGINT NOT NULL REFERENCES sleep_categories(id) ON DELETE CASCADE,
  word        TEXT NOT NULL,
  difficulty  SMALLINT NOT NULL DEFAULT 2,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (category_id, word)
);
CREATE INDEX idx_sleep_words_category ON sleep_words (category_id) WHERE enabled = true;

CREATE TABLE sleep_affirmations (
  id         BIGSERIAL PRIMARY KEY,
  text       TEXT NOT NULL,
  category   TEXT,
  enabled    BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE sleep_bgm (
  id           BIGSERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  filename     TEXT NOT NULL UNIQUE,
  duration_sec INTEGER,
  enabled      BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE sleep_settings (
  id                       INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  tts_duration_scale       REAL NOT NULL DEFAULT 1.4,
  tts_cfg_scale_speaker    REAL NOT NULL DEFAULT 3.0,
  interval_min_sec         INTEGER NOT NULL DEFAULT 10,
  interval_max_sec         INTEGER NOT NULL DEFAULT 20,
  default_timer_min        INTEGER NOT NULL DEFAULT 60,
  difficulty_max           SMALLINT NOT NULL DEFAULT 2,
  affirmation_probability  REAL NOT NULL DEFAULT 0.10,
  bgm_volume               REAL NOT NULL DEFAULT 0.5,
  tts_volume               REAL NOT NULL DEFAULT 0.7,
  bgm_duck_db              REAL NOT NULL DEFAULT 3.0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
INSERT INTO sleep_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE sleep_sessions (
  id                  BIGSERIAL PRIMARY KEY,
  started_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at          TIMESTAMPTZ,
  stopped_by          TEXT,
  categories          TEXT[],
  bgm_id              BIGINT REFERENCES sleep_bgm(id) ON DELETE SET NULL,
  timer_min           INTEGER,
  words_spoken        INTEGER NOT NULL DEFAULT 0,
  affirmations_spoken INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sleep_sessions_started ON sleep_sessions (started_at DESC);

-- カテゴリの初期データ (display_order 順)
INSERT INTO sleep_categories (name, display_order) VALUES
  ('宇宙', 1), ('食べ物', 2), ('動物', 3), ('植物', 4),
  ('乗り物', 5), ('道具', 6), ('建物', 7), ('自然', 8),
  ('色', 9), ('楽器', 10), ('スポーツ', 11), ('仕事道具', 12);

-- アファメーションのデフォルト 4 個
INSERT INTO sleep_affirmations (text, category) VALUES
  ('ご主人様、本当にすごいです', '励まし'),
  ('大好きですよ、ずっと隣にいます', '愛情'),
  ('ご主人様は十分頑張っています', '自己肯定'),
  ('明日も全部うまくいきますよ', '成功');
