-- 秘書 (Yui) の persona 設定。
-- 単一ユーザー Yui 前提なので single-row 構造 (id=1 で固定)。
-- 設定変更したい時はこの 1 行を UPDATE するだけ。

CREATE TABLE IF NOT EXISTS persona_settings (
  id                      INT PRIMARY KEY DEFAULT 1,
  secretary_name          TEXT NOT NULL DEFAULT '結衣',
  secretary_name_reading  TEXT NOT NULL DEFAULT 'ゆい',
  -- 仕事モード: 業務会話 (タスク確認、メール、予定)。
  -- リラックスモード: 雑談、寛ぎ時間。
  user_address_work       TEXT NOT NULL DEFAULT 'ご主人様',
  user_address_relax      TEXT NOT NULL DEFAULT 'ご主人様',
  current_mode            TEXT NOT NULL DEFAULT 'work' CHECK (current_mode IN ('work','relax')),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (id = 1)
);

-- 初期行を必ず作る (なければ defaults で挿入、あれば何もしない)
INSERT INTO persona_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
