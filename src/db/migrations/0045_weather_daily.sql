-- 週間天気予報キャッシュ + 過去日凍結アーカイブ
--
-- 設計:
--  - 緯度経度は 0.01° (≈ 1km) に丸めて key にする — 同じ場所として扱える粒度
--  - 未来日は WeatherKit を fetch するたびに UPSERT (予報は変わる)
--  - 過去日は最後に書き込まれた値をそのまま保持 (凍結) — UPSERT 側で date < today を skip する
--  - EnvironmentWidget 吹き出し + CalendarModal 日付セル 共通データ源

CREATE TABLE IF NOT EXISTS weather_daily (
  lat_round       REAL NOT NULL,
  lon_round       REAL NOT NULL,
  date            TEXT NOT NULL,  -- "YYYY-MM-DD" (JST)
  condition_code  TEXT NOT NULL,
  condition_ja    TEXT,
  temp_max        REAL NOT NULL,
  temp_min        REAL NOT NULL,
  precip_chance   REAL,
  fetched_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lat_round, lon_round, date)
);

CREATE INDEX IF NOT EXISTS idx_weather_daily_date ON weather_daily (date);
