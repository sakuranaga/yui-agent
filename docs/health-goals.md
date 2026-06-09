# ヘルス目標 (Health Goals) 設計書

## 1. 背景と目的

`body_metrics` / `food_logs` / `workout_logs` で **実績** は溜まっているが、
「ご主人様が何を目指しているか」(= **目標**) は明示的に管理していない。

目標があると:
- 各 section に**進捗バッジ**を表示できる (体重 hero に「-3.0 kg / 残り 12 日」等)
- Yui が **能動的に声かけ**できる (「ご主人様、今日まだ 3,200 歩ですね」)
- 朝のブリーフィングに**達成率**を組み込める (「昨日は kcal +200 オーバーでした」)
- 週次レポートで**継続率**を可視化できる

---

## 2. 目標の 3 種類

| Kind | 例 | 性質 | 期限 | 評価周期 |
|---|---|---|---|---|
| `one_time_by_date` | 「2026-08-31 までに 65 kg」 | **到達目標**。1 回達成すれば終わり (期限超過で fail) | **必須** | 到達 or 期限 |
| `daily_min` | 「毎日 10,000 歩」「毎日タンパク質 100g」 | **継続目標**。毎日達成すべき下限 | なし (継続) | 1 日単位 |
| `daily_max` | 「1 日 2,000 kcal 未満」 | **継続目標**。毎日超えてはいけない上限 | なし (継続) | 1 日単位 |

### 設計判断: kind を 1 テーブルで持つ vs 分ける

**1 テーブル + discriminator** にする。理由:
- UI で「目標一覧」が必要 → 1 list 表示は同じテーブルが楽
- kind 別の挙動差は evaluator (1 関数の switch) に閉じ込められる
- 3 種類しかないので構造化しすぎる旨味なし

---

## 3. 対象メトリクス (`metric_key`)

`body_metrics.metric_type` をベースに、集計派生型を含める:

### 3.1 body_metrics 直接参照
| metric_key | 由来 | 単位 |
|---|---|---|
| `weight_kg` | body_metrics 最新値 | kg |
| `body_fat_pct` | body_metrics 最新値 | % |
| `steps_daily` | body_metrics その日の値 | 歩 |
| `active_kcal_daily` | body_metrics その日 | kcal |
| `exercise_min_daily` | body_metrics その日 | 分 |
| `sleep_hours_daily` | body_metrics その日 | h |
| `distance_km_daily` | body_metrics その日 | km |
| `resting_hr` | body_metrics その日 | bpm |

### 3.2 集計派生型 (food_logs / workout_logs から JST 日次集計)
| metric_key | 計算 | 単位 |
|---|---|---|
| `kcal_daily_total` | `SUM(food_logs.total_kcal WHERE eaten_at IN day)` | kcal |
| `protein_daily_total` | 同 SUM | g |
| `carbs_daily_total` | 同 SUM | g |
| `fat_daily_total` | 同 SUM | g |
| `fiber_daily_total` | 同 SUM | g |
| `workout_count_weekly` | `COUNT(workout_logs WHERE performed_at IN week)` | 件 |
| `workout_body_parts_unique_weekly` | 距離 N 種類 (= 部位の偏り) | 種類 |

集計派生型は **goal eval 時にその場で SUM** する (= テーブルを増やさない)。

### 3.3 kind との組み合わせ妥当性

| metric_key | one_time_by_date | daily_min | daily_max |
|---|---|---|---|
| weight_kg | ✓ (主) | ✕ (毎日同じ体重は不自然) | ✕ |
| body_fat_pct | ✓ | ✕ | ✕ |
| steps_daily | ✕ | ✓ (主) | △ (普通使わない) |
| active_kcal_daily | ✕ | ✓ | △ |
| sleep_hours_daily | ✕ | ✓ | ✕ |
| kcal_daily_total | ✕ | ✕ | ✓ (主、上限) |
| protein_daily_total | ✕ | ✓ (主) | △ |
| carbs_daily_total | ✕ | △ | ✓ (糖質制限) |
| fat_daily_total | ✕ | △ | ✓ |
| fiber_daily_total | ✕ | ✓ | ✕ |
| workout_count_weekly | ✕ | ✓ (週次のはずだが daily_min で扱う、後述) | ✕ |

UI 側で kind 選択時に **妥当な metric_key だけ dropdown に出す** ように制限する。
完全には禁止しない (= "今月だけ体重 daily 計測" みたいな変則ケースもあり得る) が、
warning は出す。

**週次目標** (workout_count_weekly 等) は今回の MVP では実装しない。daily で同じ
枠に押し込めると意味が壊れるため、Phase 2 で `weekly_min` / `weekly_max` kind を
別途追加する設計余地を残す。

---

## 4. データモデル

### 4.1 `health_goals` テーブル

```sql
CREATE TABLE health_goals (
  id            BIGSERIAL PRIMARY KEY,
  metric_key    TEXT NOT NULL,                  -- §3 参照
  kind          TEXT NOT NULL,                  -- "one_time_by_date" | "daily_min" | "daily_max"
  target_value  REAL NOT NULL,                  -- 目標値 (単位は metric_key に依存)
  baseline_value REAL,                          -- one_time_by_date のみ: 開始時点の値 (進捗率計算に使う)
  deadline      DATE,                           -- one_time_by_date のみ必須
  start_date    DATE NOT NULL DEFAULT CURRENT_DATE,  -- 有効化開始日 (= 進捗計算の起点)
  label         TEXT,                           -- 表示用 ("夏までに減量" 等、NULL なら自動生成)
  enabled       BOOLEAN NOT NULL DEFAULT true,
  notes         TEXT,                           -- 自由メモ
  achieved_at   TIMESTAMPTZ,                    -- one_time が達成された日時 (= UI で勲章表示)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_health_goals_metric ON health_goals (metric_key, enabled);
CREATE INDEX idx_health_goals_kind ON health_goals (kind, enabled);
```

- **同一 metric_key + 同一 kind は 1 件まで** (= 「体重を 65kg にするゴール 2 個」とかは無し)
  - 厳密 UNIQUE 制約は付けない (= 過去達成済を残しつつ新ゴール作れるよう柔軟に)
  - UI 側で「有効化中の同 kind が既にある」警告を出す
- `baseline_value` は one_time 専用。「開始時 72kg → 目標 65kg」で「7kg のうち 4kg 達成」のような相対進捗を出す
- `achieved_at` が NOT NULL → 達成済 = UI で勲章 + 同じ goal は再評価不要
- 一度作った目標は **基本 soft delete しない** (= 履歴として残す)。完了 / 期限切れは状態だけ変える

### 4.2 達成ログ (任意、Phase 2)

「毎日継続目標を何日連続達成したか」を見るには、評価結果を log することが必要:

```sql
CREATE TABLE health_goal_daily_logs (
  id            BIGSERIAL PRIMARY KEY,
  goal_id       BIGINT NOT NULL REFERENCES health_goals(id) ON DELETE CASCADE,
  eval_date     DATE NOT NULL,
  observed_value REAL,                          -- その日の実測値
  achieved      BOOLEAN NOT NULL,
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (goal_id, eval_date)
);
CREATE INDEX idx_health_goal_daily_logs_goal_date ON health_goal_daily_logs (goal_id, eval_date DESC);
```

これがあれば「歩数 10,000 歩、5 日連続達成中」のような streak 表示が可能。
**MVP では未実装**、Phase 3 で追加。

---

## 5. 評価ロジック (`lib/health-goals.ts`)

```ts
type GoalStatus =
  | { kind: "one_time"; current: number; target: number; remaining: number;
      progressPct: number; daysLeft: number; pace: "ok" | "behind" | "ahead" | "fail" }
  | { kind: "daily_min"; today: number; target: number; achieved: boolean;
      ratio: number; remaining: number }
  | { kind: "daily_max"; today: number; cap: number; exceeded: boolean;
      ratio: number; remaining: number };

export async function evaluateGoal(goal: HealthGoal, asOf = new Date()): Promise<GoalStatus>;
```

### 5.1 `one_time_by_date` の評価

```
current   = 最新の metric 観測値 (例: 体重 70.5)
baseline  = goal.baseline_value (= 開始時の値)
target    = goal.target_value
daysLeft  = deadline - today
total_days = deadline - start_date

進捗率 progressPct = (baseline - current) / (baseline - target) × 100
                  (target < baseline の場合、つまり「減らす目標」)
                  あるいは (current - baseline) / (target - baseline) × 100 (増やす目標)

pace 判定:
- 達成 (current が target 到達) → achieved_at を SET、pace="ok"
- daysLeft < 0 かつ 未達 → pace="fail"
- progressPct >= 期待進捗 (elapsed_days/total_days) → pace="ok" or "ahead"
- progressPct < 期待進捗 → pace="behind"
```

### 5.2 `daily_min` の評価

```
today     = 今日 (JST) の metric 値 (steps_daily なら body_metrics 直接、
            protein_daily_total なら food_logs SUM)
target    = goal.target_value
achieved  = today >= target
ratio     = today / target (0-1+)
remaining = max(0, target - today)
```

### 5.3 `daily_max` の評価

```
today     = 今日 (JST) の metric 値 (kcal_daily_total 等)
cap       = goal.target_value
exceeded  = today > cap
ratio     = today / cap (0-1+, 1 超えで red zone)
remaining = max(0, cap - today)
```

### 5.4 `currentValue(metric_key, date)` の内部 helper

`metric_key` ごとに source 振り分け:
- body_metrics 系: 該当 type の同日最新値 (or 全期間最新値 = weight 等)
- `kcal_daily_total` 系: `SUM(food_logs.total_kcal)` for JST day
- `protein_daily_total` 系: 同様
- 値が無ければ `null` 返す

---

## 6. UI 統合

### 6.1 HealthModal 各 section に進捗バッジ

#### 体重 hero (one_time_by_date)
```
┌──────────────────────────────────────────┐
│   70.5 kg                               │
│   選択日の値 ・ 履歴を見る ›             │
│ ─────────────────────────────────────── │
│ 🎯 65 kg まで残り 5.5 kg / 残り 47 日   │
│ ▓▓▓▓░░░░░░░░░░░  35%                    │
│ ペース: ⚠️ やや遅れ気味                  │
└──────────────────────────────────────────┘
```

#### 活動 tile (daily_min)
歩数 tile の下に小バッジ:
```
歩数
9,200 歩
─────
🎯 10,000 / 92%   ✓ あと 800
```

達成済 (>= target) なら背景緑系、未達ならニュートラル。

#### 食事 kcal 合計カード (daily_max)
```
合計
1,840 kcal  (P 75g / C 220g / F 60g)
─────
🚦 上限 2,000 kcal / 残り 160 kcal
[========= 92%]  ← yellow zone
```

zone:
- 0-80% → green
- 80-100% → yellow (注意)
- > 100% → red (超過)

### 6.2 目標管理 UI

新 modal or HealthModal 内に「🎯 目標を管理」ボタン → モーダルで一覧 + 追加 / 編集 / 削除。

```
┌── 目標管理 ─────────────────────────────┐
│ ┌─ one_time 目標 ──────────────────────┐ │
│ │ 🎯 体重 65 kg まで                    │ │
│ │   2026-08-31 (残り 47 日) / 35% 達成  │ │
│ │   [編集] [削除]                       │ │
│ └─────────────────────────────────────┘ │
│ ┌─ 毎日達成 (下限) ────────────────────┐ │
│ │ ✓ 歩数 10,000 歩 / 日                 │ │
│ │   今日: 9,200 (92%) / 7 日連続達成中  │ │
│ │ ✓ タンパク質 100 g / 日               │ │
│ │   今日: 75 g (75%)                    │ │
│ └─────────────────────────────────────┘ │
│ ┌─ 毎日超えない (上限) ────────────────┐ │
│ │ 🚦 食事 kcal 2,000 / 日               │ │
│ │   今日: 1,840 (92%) ⚠️ 注意ライン      │ │
│ └─────────────────────────────────────┘ │
│                                          │
│ [＋ 新規目標を追加]                       │
└──────────────────────────────────────────┘
```

### 6.3 新規追加ウィザード

```
種類: ( ) 期限付き到達目標 (例: 65kg まで)
      (•) 毎日達成 (例: 1 万歩、タンパク質 100g)
      ( ) 毎日超えない (例: 2,000 kcal 未満)

メトリクス: [steps_daily ▾]   (kind に応じて妥当 metric だけ)

目標値: [ 10000 ] 歩

開始日: [2026-06-03]
期限: (one_time のみ) [2026-08-31]

ラベル (任意): [ ]
メモ: [                          ]

[キャンセル] [保存]
```

---

## 7. Yui 連動

### 7.1 env block 注入

毎ターンの env block に **今日の目標サマリ** を追加:

```
## 今日の目標 (3 件 enabled)
- 🚦 食事 kcal: 1,840 / 2,000 (92% 注意ライン) ← 残り 160 kcal
- ✓ 歩数: 9,200 / 10,000 (92%) ← あと 800 歩
- 🎯 体重: 70.5 kg → 65 kg (35% 達成、残り 47 日、ペース遅れ気味)
```

これで Yui が自然に「ご主人様、今日まだ 800 歩足りないですね」「kcal あと 160 です、夕食気をつけてくださいね」と話せる。

### 7.2 Yui tool

```ts
// 目標 CRUD
set_health_goal(metric_key, kind, target_value, deadline?, label?)
update_health_goal(id, ...)
disable_health_goal(id)
delete_health_goal(id)
list_health_goals(kind?)

// 達成状況参照 (env block でも見えるが、明示的に問われた時用)
get_goal_status(id?) — id 省略時は全件
```

会話: 「ご主人様、年末までに 65kg 目指しませんか?」→ Yui が `set_health_goal` 提案 → 確認 → 登録。

### 7.3 リマインダー基盤との連動 (Phase 4 以降)

`reminders` テーブル (= docs/reminders-system.md 設計済、未実装) ができたら、
goal evaluator が条件付き reminder を自動 attach できる:

- `daily_min` 未達 + 20:00 → 「歩数あと N 歩、お散歩いかがですか」
- `daily_max` 90% 超 + 食事入力時 → 「kcal 残り少ないですよ、お気をつけて」

これはリマインダー基盤側の condition 機構で実現する。本設計の Phase 4 で統合。

---

## 8. 既存資産との関係

| 機能 | 関係 |
|---|---|
| `body_metrics` | metric_key の主な source。読むだけ |
| `food_logs` | kcal/PFC 集計の source。読むだけ |
| `workout_logs` | workout 系目標の source (Phase 2) |
| HealthModal | 各 section に進捗バッジを表示 (本機能の主たる出力) |
| Yui env block | 今日の目標サマリを毎ターン注入 |
| profile-snapshot | mood_trend や inferred_traits に「目標達成傾向」を素材として読む |
| reminders (未) | daily_min/max の未達 trigger reminder (Phase 4 統合) |
| memory_chunks | 目標自体は別テーブル。記憶層に「ダイエット中」chunk が増えるかは別問題 |

---

## 9. 実装フェーズ

### Phase 1 — schema + 評価 + Yui env 注入
- `0050_health_goals.sql` migration
- `lib/health-goals.ts`: CRUD + evaluator (3 kind 切替)
- 既存 env block builder に「今日の目標サマリ」block 追加
- Yui tool: `set_health_goal` / `list_health_goals` / `disable_health_goal` / `delete_health_goal`

### Phase 2 — UI: HealthModal 進捗バッジ
- 体重 hero に one_time 進捗バー
- 活動 tile に daily_min バッジ (歩数/活動 kcal/運動分/睡眠)
- 食事 kcal カードに daily_max ゲージ (zone 色分け)
- `/api/health/goals` (GET list、GET status、POST create、PATCH update、DELETE)

### Phase 3 — 目標管理 modal
- 「🎯 目標を管理」ボタン → 一覧 + 編集 + 追加ウィザード
- one_time achieved_at の自動 SET (= 達成検出)
- streak 集計 (= health_goal_daily_logs テーブル + 日次 cron で書き込み)

### Phase 4 — リマインダー基盤連動
- `reminders.condition` に goal evaluator を呼べる kind 追加
- 「歩数未達で 20:00 になったら声かけ」のような pattern を設定 UI で組める

### Phase 5 (任意) — 週次 / 月次目標
- `weekly_min` / `weekly_max` kind 追加
- workout_count_weekly 等の対応
- カレンダー的な可視化

---

## 10. 既知の制約 / 注意点

- **メトリクス値の不在**: `currentValue` が null を返す日は achieved 判定が「未測定」扱い。
  daily_min の streak は「N 日連続 (測定無しは neutral)」のように扱う
- **time zone**: 全て JST 固定 (= 既存ヘルス系と同じ)
- **complexity**: kind 別 evaluator + zone 色分け + UI は割と大きい。Phase 1+2 で
  最低限動かして使いながら調整する
- **multi-goal の優先表示**: 1 つの metric_key に enabled 目標が複数あった時、UI で
  どれを表示するかは「最新 created_at」を採用 (= 編集系で過去履歴残しつつ最新優先)
- **画面の縦伸び**: 目標バッジを section ごとに追加すると HealthModal が縦に伸びる。
  既に縦長いので、デフォルト折り畳み or compact mode で逃げる選択肢あり

---

## 11. 関連設計書

- `docs/health-tracking.md` — 食事 / 体重 / 活動 / ジム の本体
- `docs/reminders-system.md` — Phase 4 連動先
- `docs/user-profile-snapshot.md` — mood_trend / inferred_traits の素材としての読み込み
