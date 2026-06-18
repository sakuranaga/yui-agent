-- DB のタイムゾーンを JST に固定する。
--
-- 背景: コンテナ既定は UTC。timestamptz 同士の比較は絶対値なので影響しないが、
-- now() の表示や date_trunc('day', now()) / CURRENT_DATE 等の SQL 日付ロジックが
-- JST の「今日」とズレる。JST 専用アプリなので DB レベルで Asia/Tokyo に固定し、
-- 新規インストールでも自動で JST になるようにする (初期セットアップ = migrations)。
--
-- 注: これは表示・SQL 日付境界の一貫性のための設定。timestamptz の保存値 (UTC) や
-- 既存の絶対時刻比較 (dedup の時間窓等) の挙動は変えない。
-- ALTER DATABASE SET は **新規接続から** 有効 (既存接続には適用されない)。
-- DB 名は固定せず current_database() を使う (.env で別 DB 名にした環境でも失敗しない)。

DO $$
BEGIN
  EXECUTE format('ALTER DATABASE %I SET timezone TO %L', current_database(), 'Asia/Tokyo');
END
$$;
