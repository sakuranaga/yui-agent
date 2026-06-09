-- 実際に再生された曲の永続履歴。MusicModal の最近再生リスト + AI による
-- 「もう一度」「先週聴いてた曲」等の参照用。
-- container_id/name は specialist が play_playlist / play_album で起動した
-- 出処を記録 (subsequent 自動切替トラックにも同じ container を紐付け)。
CREATE TABLE IF NOT EXISTS music_track_history (
  id BIGSERIAL PRIMARY KEY,
  track_id TEXT,                  -- Apple Music song id (null 可)
  title TEXT NOT NULL,
  artist TEXT,
  album TEXT,
  duration_ms INTEGER,
  container_kind TEXT,            -- 'playlist' | 'album' | 'song' | null
  container_id TEXT,
  container_name TEXT,
  played_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_music_track_history_played_at
  ON music_track_history (played_at DESC);
CREATE INDEX IF NOT EXISTS idx_music_track_history_track_id
  ON music_track_history (track_id)
  WHERE track_id IS NOT NULL;
