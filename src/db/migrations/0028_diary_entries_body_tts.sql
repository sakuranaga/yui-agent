-- 日記の読み上げ用 (TTS 正規化済) 本文カラムを追加。
-- まだ §7.8 TTS 前処理パイプラインは未実装なので NULL のままで運用、
-- 将来 normalizeForTTS が動いたら埋める。読み上げ時は body_tts があれば
-- そちらを優先、無ければ body をそのまま使うフォールバック方針。

ALTER TABLE diary_entries
  ADD COLUMN IF NOT EXISTS body_tts TEXT;
