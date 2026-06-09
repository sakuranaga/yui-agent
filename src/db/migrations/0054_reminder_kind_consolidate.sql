-- リマインダー通知 kind を 4 つ (reminder_habit / reminder_todo_due / reminder_event_due / reminder_custom)
-- から `reminder` 1 つに統合。
--
-- 背景: 性質ごとに個別設定できるようにしてたが、ご主人様の運用では全部同じ通知方式で十分なので
-- UI シンプル化のため 1 行に集約。reminder.kind 列 (habit / todo_due / event_due / custom) は
-- 内部分類用として reminders テーブルに残るが、通知マトリックスは 1 行のみ。

INSERT INTO notification_settings (event_kind, mode_online, mode_away, mode_focus, discord_policy, importance) VALUES
  ('reminder', 'notify', 'notify', 'speak', 'away_only', 'normal')
ON CONFLICT (event_kind) DO NOTHING;

DELETE FROM notification_settings WHERE event_kind IN (
  'reminder_habit',
  'reminder_todo_due',
  'reminder_event_due',
  'reminder_custom'
);
