-- メール仕分け学習: 自動アクション consent フラグ
-- 設計: docs/mail-classification.md §4.1, §5.6, §12 Phase 2
--
-- bucket=重要 でも「実際に TODO / 予定 を自動登録していいか」は別。
-- 学習例ごとに user が明示同意して保存する。Phase 2 で UI 公開、
-- Phase 3 で実際の auto-action ゲート条件に使われる。

ALTER TABLE mail_training_examples
  ADD COLUMN IF NOT EXISTS auto_todo  BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_event BOOLEAN NOT NULL DEFAULT false;
