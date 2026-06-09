# リマインダー機能 設計書

## 1. 背景と目的

ご主人様の予定 (TODO 期限 / Calendar イベント) や習慣 (毎週ジム / 毎朝ストレッチ等) に
対し、**ゆいが能動的に文脈読み取った声かけ・通知をする**経路が欲しい。

これを **専用の `reminders` テーブル + 1 dispatcher** で一本化し、TODO・Calendar・
習慣の各経路から流し込めるようにする。

### タイマー / アラーム / リマインダーの境界

既存 `timers` テーブルが「タイマー / アラーム」を担当 (`kind="timer"` / `"alarm"`)。
本設計の `reminders` は別物。

| 機能 | 用途 | 性質 | 例 |
|---|---|---|---|
| **タイマー** (timers.kind=timer) | 相対秒数カウントダウン | 鳴る / 通知 | 「3 分後にカップ麺」 |
| **アラーム** (timers.kind=alarm) | 絶対時刻起動 (目覚まし的) | 鳴らす | 「明日 6 時、JPOP で起こして」 |
| **リマインダー** (reminders、本設計) | 予定・習慣の催促 | 思い出させる | 「13 時ランチを 1 時間前にリマインド」「毎朝ジム行きましたか?」 |

軸は「**鳴らす vs 思い出させる**」。Yui の判定ルールは §7.2 で詳述。

---

## 2. データモデル

### 2.1 `reminders` (新規)

```sql
CREATE TABLE reminders (
  id              BIGSERIAL PRIMARY KEY,
  kind            TEXT NOT NULL,            -- "habit" | "todo_due" | "event_due" | "custom"
  title           TEXT NOT NULL,            -- "ジム" / "薬 (朝)" / "若園さんとランチ"
  extra_prompt    TEXT,                     -- speak mode 時の追加指示 (例: "朝の分まだなら飲むよう促して")
  schedule        JSONB NOT NULL,           -- §2.2 参照
  ref_table       TEXT,                     -- back-link (例: "todos")
  ref_id          BIGINT,                   -- back-link 先 id
  enabled         BOOLEAN NOT NULL DEFAULT true,
  last_fired_at   TIMESTAMPTZ,
  fire_count      INTEGER NOT NULL DEFAULT 0,
  next_due_at     TIMESTAMPTZ,              -- dispatcher が計算する次回発火時刻 (高速化用)
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_reminders_enabled_next ON reminders (enabled, next_due_at);
CREATE INDEX idx_reminders_ref ON reminders (ref_table, ref_id);
```

設計要点:
- **`output_kind` 列なし**: 出口は通知マトリックス (`notification_settings`) で kind × user_state ごとに切替 (§4)
- **`fire_prompt` 列なし**: 発火時に dispatcher が `title` + `extra_prompt` を Yui に渡して動的生成 (§4)
- **`importance` 列なし**: notification の importance も matrix 設定 (kind 単位) から導出
- **GCal event との back-link なし**: ref_table は internal table 専用 (`todos` 等)。GCal 連携は §6.2 参照

### 2.2 `schedule` JSON フォーマット

2 種類サポート:

```json
// (a) 一回限り (= 単発予定・TODO 期限)
{
  "kind": "once",
  "base_at": "2026-06-05T13:00:00+09:00",   // 紐付け予定の時刻 (= ランチ自体)
  "lead_minutes": 60                          // 何分前にリマインドするか (0 = 同時刻)
}
// fire 時刻 = base_at - lead_minutes 分

// (b) 繰り返し (= 習慣)
{
  "kind": "weekly",
  "base_time": "08:00",                       // ベース時刻 HH:MM
  "weekdays": [1,3,5],                        // 0=Sun..6=Sat、空配列 = 毎日
  "lead_minutes": 0,                          // 通常 0、必要なら指定可
  "tz": "Asia/Tokyo"                          // 将来用、現状は JST 固定
}
```

MVP は (a) + (b) のみ。cron 風表現は将来必要なら追加。

`lead_minutes` を **DB に明示的に持つ**理由: user 視点で「ランチ自体は 13 時、リマインドは 1 時間前」が直感的。編集 UI で base と lead を独立に編集できる。

---

## 3. Dispatcher

`src/periodic/reminder-dispatch.ts` を新規追加 (PeriodicModule)。

### 3.1 動作

- **schedule**: `{ kind: "interval", everyMs: 60_000 }` (1 分間隔)
- **run()**:
  1. 現在時刻 (JST) を取得
  2. `reminders WHERE enabled AND next_due_at <= now()` を取得
  3. 各行について:
     - 通知マトリックス (= `notification_settings`) を kind × 現在の user_state で lookup
     - mode に応じて分岐 (§4)
     - `last_fired_at = now()`, `fire_count++`, `next_due_at = compute_next()` を更新
  4. 複数行を 1 ターンで処理 (判定段のみコスト、発話/通知は既存系統)

### 3.2 `compute_next()`

```
schedule.kind="once":
  → 発火後 enabled=false、next_due_at=null (= リマインドは 1 回限り)
schedule.kind="weekly":
  → 次の該当曜日 + 該当時刻 - lead_minutes
  → 今日が該当曜日でも last_fired_at が今日なら翌週分
```

### 3.3 重複発火防止

`last_fired_at` ベースの dedup window:
- `weekly` (habit): その日 1 回まで
- `once` (todo_due / event_due / custom): 1 reminder につき 1 回 (発火後 enabled=false)

### 3.4 複数 reminder の同時発火

集約 **しない**: Yui voice キュー / お便りページネーション / トーストスタックがいずれも
多重表示対応済みなので、3 個同時 fire なら 3 個独立に流す。

---

## 4. 出力経路 (= 通知マトリックスで決まる)

通知マトリックス (`notification_settings`) の各 kind × user_state に対する mode 設定:

| mode | 動作 |
|---|---|
| `speak` | dispatcher が内部 /api/chat 経由で Yui ターン起動、Yui が動的に発話生成 |
| `notify` | `saveNotification()` 1 本 (お便りバッジ + トースト) |
| `discord` | `notify` + 既存 Discord forward hook |
| `silent` | skip |

(同一 kind × user_state に複数 mode が同時 ON もあり得る、その時は全部実行)

### 4.1 speak mode の Yui ターン起動

dispatcher が以下のプロンプトを内部 `/api/chat` に POST:

```
[リマインダー発火] 「{title}」のリマインダーです。
{extra_prompt があれば: 追加指示: {extra_prompt}}
ご主人様に文脈に合った自然な声かけをしてください。
機械的に「リマインダーの時間です」とは言わない。
```

Yui (Sonnet) が文脈・時間帯・直近のやり取りを踏まえて発話。

例 (title="ジム"):
- 「ご主人様、今日はジムの日ですね。行ってきましたか?」 (= 月曜の 19 時、user が在宅中)
- 「ご主人様、お疲れさまです。ジムどうします?」 (= 仕事終わりの時間)

### 4.2 notify mode

`saveNotification()` 経由:
```ts
await saveNotification({
  sessionId,
  kind: `reminder_${reminder.kind}`,         // "reminder_habit" 等
  title: reminder.title,                      // "ジム" / "若園さんとランチ"
  preview: reminder.title,
  bodyMd: reminder.title,                     // 本文も簡素 (title だけ)
  refTable: "reminders",
  refId: reminder.id,
});
```

トースト / お便りバッジ / 集中モード抑制 / 夜間オーバーライドは notification system 任せ。

### 4.3 discord mode

`notify` と同じ saveNotification 経由。Discord forward は既存 hook で自動。

---

## 5. UI: 専用モーダル

Topbar に bell アイコン (lucide `bell-ring`) を追加、押下で `RemindersModal` を開く。

### 5.1 リスト画面

```
🔔 リマインダー
├── 一覧 (有効/無効 / 編集 / 削除)
│    ├── [毎週月水金] ジム             19:00         [✓ 有効]  最終: 6/2
│    ├── [毎朝]      薬                 08:00         [✓ 有効]  最終: 6/3
│    ├── [単発]      若園さんとランチ   6/5 12:00 (1h前 / ランチ 13:00)  [✓ 有効]
│    └── [TODO 期限] 確定申告           6/15 09:00    [✓ 有効]   → TODO 「確定申告」
└── + 新規追加
     ├── 種類: [habit / custom] (todo_due / event_due は紐付け作成のみ)
     ├── タイトル: ___
     ├── 追加指示 (任意): ___
     ├── スケジュール:
     │    [○ 単発]:  ベース日時 ___  /  リマインド ○分前 (preset: 5/30/60/カスタム)
     │    [○ 繰り返し]: ベース時刻 ___ /  曜日 chips (日月火水木金土) /  ○分前
     └── (有効/無効 toggle)
```

### 5.2 編集 popup

行クリックで編集 popup (= `confirm-popup-accent` 流儀)、上記フォームと同じ項目。

### 5.3 TodoModal / CalendarModal 連携

各 row に「+リマインダー」ボタン (chip):

- **TodoModal**: TODO 一覧の row に + ボタン。押下で popup → title pre-fill (= TODO.title)、base_at は user 指定 (TODO.due は日付のみなので時刻入力必須)、ref_table='todos', ref_id=todo.id
- **CalendarModal**: event row に + ボタン。押下で popup → title pre-fill (= event.summary)、base_at = event.start で pre-fill、lead_minutes 入力 (preset: 5/30/60)。**back-link は持たない** (= GCal event ID 連携なし、reminder は独立)
- 「+リマインダー」追加された row には小さい bell マーク表示 (= 視認で「リマインダーあり」分かる)

---

## 6. Yui Tool

### 6.1 Tool 一覧

```ts
{
  name: "add_reminder",
  description:
    "リマインダー (予定・習慣の事前通知) を作成。" +
    "判定: 「リマインダー / 教えて / 思い出させて / 忘れないように」明示時、" +
    "繰り返し (毎朝/毎週/曜日指定) 時、TODO/予定と同時生成時 (back-link あり) は必ずここ。" +
    "「アラーム / 目覚まし / 起こして」明示時 は create_timer(kind='alarm') に流す。" +
    "「時刻指定のみで動詞曖昧」は既定でリマインダー (= alarm はデフォにしない)。",
  input_schema: {
    properties: {
      title: { type: "string", description: "見出し (例: 'ジム', '薬 (朝)', '若園さんとランチ')" },
      extra_prompt: { type: "string", description: "(任意) 発火時の追加指示" },
      schedule_kind: { enum: ["once", "weekly"] },
      // once 用
      base_at: { type: "string", description: "kind=once 用。RFC3339/ISO8601" },
      // weekly 用
      base_time: { type: "string", description: "kind=weekly 用。HH:MM (JST)" },
      weekdays: { type: "array", items: { type: "integer", minimum: 0, maximum: 6 } },
      // 共通
      lead_minutes: { type: "integer", default: 0, description: "何分前にリマインドするか" },
      // 紐付け (TODO のみ。GCal event との紐付けは無し)
      ref_todo_id: { type: "integer" },
    },
    required: ["title", "schedule_kind"],
  },
}
```

ほか:
- `list_reminders`: active reminder 一覧
- `disable_reminder(id)` / `enable_reminder(id)`
- `delete_reminder(id)`

### 6.2 Yui プロンプト追記

`yui-prompt.ts` に **タイマー/アラーム** ブロックと並べて **リマインダー** ブロック追加:

```
【リマインダー (add_reminder / list_reminders / disable_reminder / delete_reminder)】
あなたは Yui 自身でリマインダーを設定できます。
判定軸: 鳴らす (alarm) vs 思い出させる (reminder)。

- **習慣 (繰り返し)**: 「毎週月水金 19 時にジム行きましたか?」「毎朝 8 時に薬」
  → add_reminder(kind="habit", schedule_kind="weekly", weekdays=..., base_time=...)

- **単発予定リマインド**:
  - 「明日 13 時にランチ、1 時間前にリマインダー」 → gcal_create_event(13:00) + add_reminder(once, base_at=13:00, lead_minutes=60)
  - 「明日 18 時にメール返信のリマインダー」 → add_reminder(once, base_at=18:00, lead_minutes=0, kind="custom")
  - 「明日のジムの 30 分前に教えて」 → add_reminder(once, base_at=明日のジム時刻, lead_minutes=30)

- **TODO への紐付け**: TODO 作成時に user が「リマインダーも」と明示 → add_todo + add_reminder(ref_todo_id=新規 todo.id)

- title は **短い見出し** (例: "ジム" / "薬 (朝)" / "ランチ@若園")。発火時の発話文は dispatcher が動的生成するので、ここに発話文は入れない。
- extra_prompt は **特殊な指示がある時のみ** (= 普段は空欄でいい)
- 「リマインダー」「教えて」「思い出させて」「忘れないように」キーワード → ここ
- 「アラーム」「目覚まし」「起こして」キーワード → create_timer(kind="alarm") に流す
- 時刻指定のみで動詞曖昧 → 既定でリマインダー (= alarm はデフォにしない)

応答方針:
- セット直後の ack: 「明日 12 時、ランチの 1 時間前にリマインドしますね」「毎週月水金のジムをリマインダーにしました」等、短く一言
- 発火時は別経路でユーザに自動通知 (notify/speak/discord matrix) されるので、セット時に「○時になったら教えます」は不要
```

`create_timer` 側の description にも「リマインダー」明示時はこちらでなく `add_reminder` を使う、と注意書きを追加 (= 既に Step 1 で実施済み)。

---

## 7. TODO 連携

### 7.1 TODO 作成 / 紐付け

- TODO 側に列追加 **なし**。reminders.ref_table='todos', ref_id=<bigint> で back-link
- TODO 作成と reminder 作成は別 tool (= add_todo + add_reminder)。Yui が user 明示時に並列実行
- TodoModal の各 row に「+リマインダー」ボタンで手動追加可能

### 7.2 TODO 完了 / 削除時の cleanup

- `complete_todo(id)` / `delete_todo(id)` 時、reminders から `WHERE ref_table='todos' AND ref_id=$1` を削除 (= 紐付いた reminder も消える)

### 7.3 back-link 表示

- TodoModal の TODO row に「🔔 」マーク (= リマインダー紐付いてる)
- RemindersModal の reminder row に「→ TODO 「○○」」リンク

---

## 8. Calendar (GCal) 連携

### 8.1 連携方針 = back-link なし

GCal event は外部 (Google Calendar API) で管理されてるため、reminder からの back-link は持たない:
- 「予定 + リマインダー」は Yui が 2 tool 並列実行 (gcal_create_event + add_reminder)
- 両者は独立、event の時刻変更/削除に reminder は追従しない (= 将来要望出たら拡張)

### 8.2 UI 連携

CalendarModal の各 event row に「+リマインダー」ボタン:
- popup で title (= event.summary) と base_at (= event.start) を pre-fill
- user が lead_minutes (preset 5/30/60 + custom) と曜日 (繰り返しの場合) を指定
- 作成される reminder は独立 (ref_table=null)

---

## 9. 通知マトリックス統合

既存 `notification_settings` テーブル (kind × user_state → mode) に **`reminder` 1 行** を追加:

| kind | default modeOnline | modeAway | modeFocus | discordPolicy | importance |
|---|---|---|---|---|---|
| `reminder` | notify | notify | speak | away_only | normal |

`reminders.kind` 列 (habit / todo_due / event_due / custom) は内部分類用として残るが、
**通知マトリックスは reminder 1 つに集約** (= ご主人様の使い方として、種類別に通知方式を変える需要が薄いため UI シンプル化を優先)。

将来「習慣は集中時 silent、TODO 期限は集中時 speak」のような差を入れたくなったら kind 別行に分離 (= migration で 4 行に戻す)。

---

## 10. 実装フェーズ

### Phase 1 (= 本設計の範囲、全部やる)

- migration `0053_reminders.sql` (table + index + notification_settings に kind 4 行追加)
- `src/lib/reminders.ts` (CRUD + compute_next)
- `src/periodic/reminder-dispatch.ts` (1 分 interval, matrix lookup + 分岐)
- `src/components/RemindersModal.tsx` (Topbar bell アイコン経由、一覧 + 編集 popup)
- TodoModal / CalendarModal に「+リマインダー」ボタン
- Yui tool 4 種 (add_reminder / list_reminders / disable_reminder / delete_reminder)
- yui-prompt.ts に「リマインダー」ブロック追加

### Phase 2 (任意 / 将来)

- **reminder_fires** テーブル (= 発火履歴 / 達成率可視化、ジム reminder 達成率等)
- **GCal event との back-link** (= event 時刻変更追従)
- **condition 評価** (= 服薬「飲んだら今日は鳴らさない」、服薬機能着工時に追加)
- **cron 風 schedule** (= 平日のみ / 月次等の複雑表現)
- **reminder → TODO 昇格ボタン** (= 鳴ったけど今やる気起きない時に TODO 化、intent + artifact_links 流用)

---

## 11. 既存機能との関係

| 機能 | 関係 |
|---|---|
| `timers` (タイマー / アラーム) | **別物**。境界は §1 参照 |
| morning-check (毎朝 briefing) | 当面両立。将来 morning-check も reminder で表現できるなら統合検討 |
| notification system | reminder の出口として 100% 再利用、新規実装なし |
| お便りバッジ / トースト / Discord forward | 同上 (notification system 経由で自動) |
| TODO / Calendar | §7 / §8 参照 |

---

## 12. 既知の制約 / 将来

- **複数 user 対応無し** (= 単一ご主人様用)
- **タイムゾーンは JST 固定** (`schedule.tz` 列は将来用)
- **dispatcher 落ち時の miss** = catch-up しない (= 12 時間前の reminder が今鳴っても無意味)
- **スヌーズなし** — reminder は鳴ったら終わり。alarm 側の snooze は別途 timers 側で実装予定 (本設計スコープ外)
- **GCal event の時刻変更追従なし** (= Phase 2 拡張)
- **服薬機能 / condition 評価は本設計に含めない** (= 服薬機能着工時に reminders 側を拡張)
- **TODO recurrence (= 毎週 TODO 化)** は対象外。「毎週月曜ゴミ」は reminder.weekly で表現 (= TODO 化しない)

---

## 13. 関連設計書

- `docs/notification-system.md` — 出力経路の元 / matrix 設定
- `docs/roadmap.md` §3 (Habits + Proactive) — 上位設計
