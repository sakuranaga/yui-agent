# ヘルス領域 統合設計書

(旧: 食事ログ + メトリクス統合)

## 0. 領域マップ

Yui のヘルス hub は以下 8 領域をカバーする。

| 領域 | 入力経路 | ストレージ | Yui tool | 通知/能動声かけ |
|---|---|---|---|---|
| 🍽 食事 | 会話自動抽出 + modal 編集 | `food_logs` + `food_reference` (cache) | `get_food_summary` | 朝の briefing |
| ⚖ 体重・体脂肪 | 会話「今朝 72kg」 + modal 手入力 + HealthKit | `body_metrics` (generic) | `get_weight_trend` | 週次レポート |
| 👟 活動 (歩数 / kcal) | **HealthKit only** (会話に出にくい) | `body_metrics` | `get_activity_today` | 朝「昨日 8000 歩」 |
| 💪 ジム / 筋トレ | 会話「ジム下半身」 + 詳細 modal | `workout_logs` (専用、種目 × set × rep × 重量) | `get_workout_history` | Yui 提案「今日上半身どう?」 |
| 💊 服薬 | modal マスタ + 会話「薬飲んだ」 | `medications` + `medication_logs` | `get_medication_status` | リマインダ「お薬飲みましたか?」 |
| 😴 睡眠 | HealthKit pull / 既存 sleep_session | `body_metrics` (sleep_h) 連結 | `get_sleep_last_night` | 朝「昨日 6h」 |
| 🧠 気分 | modal 1-5 + 会話「今日疲れた」 | `body_metrics` (mood_1to5) | `get_mood_trend` | 後フェーズ |
| ❤ バイタル | HealthKit pull (心拍/血圧) | `body_metrics` | (後ろのフェーズ) | 異常検知後 |

### ストレージ設計原則

- **汎用 `body_metrics`** で済むもの: 体重、体脂肪、歩数、活動 kcal、気分、心拍、血圧、睡眠時間 (= スカラー値 × 時刻)
- **専用 table が必要なもの**:
  - **ジム** — 種目別の set/rep/重量を集計したい (前回部位、PR、ボリューム計算)
  - **服薬** — 薬マスタ (用法・1 日 N 回) + 服用ログ (adherence 計算用)

### 抽出器の分割

各経路ごとに post-turn extractor が独立して走る (LLM コストはローカル LLM 前提)。

- `food-extract.ts` — 食事 + **体重・体脂肪・気分** の軽い相乗り (1 文「今朝 72kg だった、疲れた」で全部拾える)
- `workout-extract.ts` (Phase 3) — 「ジム / 筋トレ / 走った」検出
- `medication-extract.ts` (Phase 4) — 「薬飲んだ」検出 → schedule に対する taken 印
- HealthKit pull は cron 経路 (Phase 5)、extractor は通らない

### Yui の自然な参照経路

Yui の chat tool に `get_*` を追加することで自然な対話に組み込める:
- 「今日いくら食べた?」→ `get_food_summary(today)` → 「376 kcal です」
- 「今日のジムどうしようかな」→ `get_workout_history(last_2_sessions)` → 「昨日は上半身でしたから、下半身どうですか」
- 「お薬飲みましたか?」(Yui 能動) → `get_medication_status(today)` で未服用の薬リスト取得

### モーダル構造 (フェーズ別)

```
ヘルスモーダル
├─ 今日タブ ← Phase 2 はここまで
│   ├─ 食事 ✓
│   ├─ 体重 ✓
│   ├─ 気分 (1-5 入力)
│   ├─ 服薬チェック (Phase 4)
│   └─ 今日のジム (Phase 3)
├─ ジムタブ (Phase 3)
│   └─ 履歴 + 「次は何鍛える?」 Yui レコメンド
├─ 服薬タブ (Phase 4)
│   └─ 薬リスト編集 + adherence カレンダー
├─ 履歴タブ (Phase 6)
│   └─ 体重 / 歩数 / kcal の週次・月次グラフ
└─ 連携タブ (Phase 5)
    └─ HealthKit / 各 API 接続設定
```

### フェーズ計画 (上書き)

- **Phase 1** ✓ 食事 schema + extractor + 栄養 lookup
- **Phase 2** ✓ ヘルスモーダル + 体重 / 気分 の食事 extractor 相乗り + `get_food_summary` tool + 明示メトリクスの quick-save
- **Phase 3** ✓ ジム機能 (`workout_logs` schema + `workout-extract.ts` + ヘルスモーダル運動セクション + `get_workout_history` tool)
- **Phase 4 (保留)** 服薬機能 — リマインダー基盤 (= 別 phase) ができてから着手する
- **Phase 5** ✓ HealthKit 連携 (`/api/health/import` + `health-import.ts` の UPSERT / append + 専用 `/api/health/activity` + ヘルスモーダル活動セクション + `today_activity` / `recent_steps` / `recent_hr` range)
- **Phase 6** ✓ 履歴グラフ (`/api/health/range` + ヘルスモーダル日次/週次/月次 view + 日付 ◀▶ nav + 体重 line + 気分 dot + 活動/食事 bar chart)
- **Phase 6.1 (将来)** 朝の briefing にヘルス summary 統合 / 週次レポート Yui 自動生成

### 残タスク (TODO)

#### A. ヘルス本体 内側
- [ ] **食事 extractor 複数食対応の動作検証** — Phase 6 末で foods[] 配列化済。「朝/昼/夜/おやつ」みたいな multi-meal 一括投入が複数行で入るか実会話で確認 (5 分 debounce 経過後に `food_logs` 確認)
- [ ] **食事カードに編集/削除を popup 化** — 現在の食事カードは day mode 内に並ぶが、件数増えると縦に長い。体重と同じく hero (今日の合計) + popup で展開する形にできると一貫
- [ ] **気分の手動入力 UI** — 今は会話経由 (extractor) 通すか手動 POST のみ。気分は速攻入れたい場面が多い (アイコン 5 つから tap)。day mode の体重 hero 隣に置く想定
- [ ] **HealthKit データの period_min / period_avg 表示** — Phase 6 の sparkline は raw value のみ。週次/月次 view では「平均歩数 8,200 歩」のような period 集計 line chart があると便利
- [ ] **食事 PFC グラフ** — Phase 6 月次 view に macronutrient (P/C/F) のスタック棒があると body comp の判断材料になる

#### B. 別 phase 待ち
- [ ] **#186 リマインダー / habits 共通基盤** — 服薬・週間 habits・水分補給・服用時の通知に共通で必要な土台
  - `reminders` テーブル: id / kind / schedule (cron-like or 時刻+曜日) / condition (= 「今日 X 未記録」等) / last_fired_at / enabled
  - `periodic/reminder-dispatch.ts` で 1 分 interval で評価 → `saveNotification` 経由でお便りバッジ or Yui voice
  - 設定モーダルに reminder 一覧 UI (有効/無効、編集、削除)
- [ ] **#183 Phase 4 服薬機能** — #186 完成後に着手。`medications` (薬マスタ: 名前 / 用法 / 用量 / 推奨タイミング) + `medication_logs` (服薬記録) + extractor (「薬飲んだ」検出) + ヘルスモーダル服薬 section + `get_medication_status` tool。Yui が「お薬の時間です」「飲み忘れていませんか?」を出せるように

#### C. 運用準備 (コードではなく設定)
- [ ] `.env` に `HEALTH_INGEST_KEY=<32 文字程度のランダム文字列>` を追加 → `docker compose restart web`
- [ ] iOS Shortcut を Phase 5 補足通り組む + Automation で「毎時」or 「帰宅 Wi-Fi 接続時」trigger
- [ ] ダミーデータ掃除 (本番稼働前):
  ```
  docker compose exec postgres psql -U vroid -d vroid -c "DELETE FROM body_metrics WHERE source IN ('apple_health_mock', 'manual_mock');"
  ```
  - `apple_health_mock`: HealthKit 7 日分ダミー (`src/scripts/seed-health-mock.ts`)
  - `manual_mock`: 体重 29 日分ダミー (一回限りの SQL insert)

### Phase 5 補足: iOS Shortcut 設定例

`Settings > Shortcuts > New Shortcut`:

1. `Get Health Sample` (Step Count, today) → 変数 `steps`
2. `Get Health Sample` (Active Energy, today) → 変数 `activeKcal`
3. `Get Health Sample` (Exercise Time, today) → 変数 `exerciseMin`
4. `Get Health Sample` (Walking + Running Distance, today, km) → 変数 `distanceKm`
5. `Get Contents of URL`:
   - URL: `https://<your-host>/api/health/import`
   - Method: POST
   - Headers: `X-Health-Key: <env HEALTH_INGEST_KEY と同じ値>`, `Content-Type: application/json`
   - Body (JSON):
     ```json
     {
       "source": "apple_health",
       "metrics": [
         { "type": "steps_daily", "value": steps, "date": "<今日 YYYY-MM-DD JST>" },
         { "type": "active_kcal_daily", "value": activeKcal, "date": "..." },
         { "type": "exercise_min_daily", "value": exerciseMin, "date": "..." },
         { "type": "distance_km_daily", "value": distanceKm, "date": "..." }
       ]
     }
     ```
6. Automation で「毎時」「Wi-Fi 接続時」等を trigger に設定。

サーバ側: `.env` に `HEALTH_INGEST_KEY=<32 文字程度のランダム文字列>` を追加して docker compose restart。

POST 結果は `{ accepted, rejected, upserted, inserted, errors }` を返す。日次集計は同日 UPSERT、心拍など point-in-time は append。範囲外値 (歩数 20 万超など) は reject。

---

(以下、Phase 1 設計の詳細)

# 食事ログ + メトリクス統合 設計書

## 1. 背景と目的

Yui は既に「縦串アグリゲーション」(メール × 連絡先 × プロジェクト × 日記...) を持っているが、健康領域には未進出。一方、既存サービスは全部サイロ:

- MyFitnessPal: 食事のみ
- Apple Health: 活動のみ
- Withings: 体重のみ

それぞれ別アプリで入力 → 摩擦が高くて続かない (食事ログの大半は 2-3 週で離脱する)。

Yui に「自然会話 → 自動記録」を持たせれば:

1. **入力摩擦が桁違いに低い** — 「サンドイッチ食べた」で 5 秒、検索/フォーム不要
2. **クロスドメイン分析** が可能 — 「日記でストレス高い週、間食 +30%」みたいな単一アプリでは出ない insight
3. **継続率** — Yui の優しい声かけ ("最近記録ない日が増えてるみたい") で離脱を拾える

## 2. 用語

| 用語 | 意味 |
|---|---|
| **食事ログ (food log)** | 1 回の食事/間食の記録 (時刻、内容、栄養、源 message) |
| **メトリクス (body metrics)** | 体重・体脂肪・運動・気分などの時系列計測値 |
| **post-turn extractor** | Yui 応答完了後、async で会話を読んで食事言及を検出する役 |
| **栄養 cache** | 食材名 → kcal/PFC のキャッシュテーブル (一度引いたら使い回す) |
| **eaten_at** | 実際に食べた時刻 (JST)。会話時刻と一致しないケースに注意 |
| **debounce** | 同じ食事の二重記録を防ぐため、会話が落ち着くまで extractor を待たせる |

## 3. 全体アーキテクチャ

```
ご主人様 → チャット入力 "サンドイッチ食べた"
   ↓
chat/route.ts (既存) → Yui 応答 → raw_messages 書き込み
   ↓ fire-and-forget
post-turn food extractor (新規、Gemma 1 呼び出し)
   ↓ 直近 3 turn pair を context
   ↓ debounce: 5 分以内に同 session の新発話あれば待機
   ↓ Gemma 出力 JSON
     { detected, items: [{name, quantity, unit}],
       eaten_at_iso, raw_text_excerpt, confidence }
   ↓ detected == true && confidence >= 0.7
   ↓ 各 item → 栄養 lookup (cache hit or web 検索)
   ↓ food_logs に INSERT
   ↓ (Phase 3) Yui の朝 briefing 等で参照
```

Yui のメイン応答経路には触れない。persona も汚さない。

## 4. データモデル

### 4.1 食事ログ (`food_logs`)

```sql
CREATE TABLE food_logs (
  id              BIGSERIAL PRIMARY KEY,
  eaten_at        TIMESTAMPTZ NOT NULL,
  raw_text        TEXT NOT NULL,                    -- user の元発言 (debounce 比較用)
  items           JSONB NOT NULL,                   -- [{name, quantity, unit, kcal, protein, carbs, fat, fiber, ref_id}]
  total_kcal      REAL,
  total_protein   REAL,
  total_carbs     REAL,
  total_fat       REAL,
  total_fiber     REAL,
  source_message_id BIGINT REFERENCES raw_messages(id) ON DELETE SET NULL,
  notes           TEXT,
  confidence      REAL NOT NULL,                    -- extractor 出力
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON food_logs (eaten_at);
CREATE INDEX ON food_logs (source_message_id);
```

`items` は jsonb で柔軟に。集計は denormalized `total_*` で速度確保。

### 4.2 栄養 cache (`food_reference`)

```sql
CREATE TABLE food_reference (
  normalized_name TEXT PRIMARY KEY,    -- "ツナサンドイッチ" "ご飯 茶碗1杯" 等
  unit            TEXT NOT NULL,       -- "個" "本" "100g" etc.
  kcal_per_unit   REAL NOT NULL,
  protein         REAL,
  carbs           REAL,
  fat             REAL,
  fiber           REAL,
  source_url      TEXT,
  confidence      TEXT NOT NULL,       -- "high" / "medium" / "low"
  looked_up_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

normalize: 全角→半角、空白潰し、lowercase。「カラアゲ」「唐揚げ」「からあげ」は LLM 側で同一化を試みる (cache hit ratio 向上)。

### 4.3 体メトリクス (`body_metrics`)

```sql
CREATE TABLE body_metrics (
  id              BIGSERIAL PRIMARY KEY,
  metric_type     TEXT NOT NULL,        -- "weight_kg" / "body_fat_pct" / "exercise_kcal" / "mood_1to5" / etc.
  value           REAL NOT NULL,
  recorded_at     TIMESTAMPTZ NOT NULL,
  notes           TEXT,
  source          TEXT NOT NULL DEFAULT 'manual',  -- "manual" / "healthkit" / "extracted"
  source_message_id BIGINT REFERENCES raw_messages(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX ON body_metrics (metric_type, recorded_at DESC);
```

Phase 1 では food_logs のみ使用。Phase 2-3 で metrics に体重などを入れる。

## 5. 食事抽出パイプライン

### 5.1 起動タイミング

`chat/route.ts` の応答 + raw_messages 書き込みが完了したあとに **fire-and-forget** で呼ぶ:

```ts
void writePromise
  .then(() => {
    if (isPrivate) return;          // プライベートモードでは抽出しない
    void extractFood({ sessionId }).catch(...);
    // 既存の memory extract は別系統で並走
  });
```

### 5.2 debounce 戦略

同じ食事を 2 回保存しないため:

```
T1: user "朝ごはん食べた" → Yui "何ですか?"
    → extractor 起動準備、5 分タイマー
T2: user "ツナレタス卵" (5 分以内)
    → 前タイマーを cancel、新タイマー 5 分
T3: 5 分無発話
    → extractor 実行、T1 〜 T2 + assistant 応答を context として食事検出
```

実装: `pending-extract:<sessionId>` Valkey key に timestamp を保存、新発話で更新。setTimeout で 5 分後にチェック (timestamp が変わってなければ実行)。

サーバ再起動でタイマー消えるが、次回の発話で再度キックされるので大きな問題なし。

### 5.3 Gemma プロンプト (出力 JSON 固定)

```
あなたは食事ログ抽出係です。直近の会話から「ご主人様が食べたもの」を抽出します。

判定基準:
- 過去〜現在進行の食事 → detected = true
- 「これから食べる」「明日の朝ごはん何にしよう」等の予定 → detected = false
- "美味しそう" "見た" 等の話題化のみで自分が食べてない → detected = false

出力 JSON 1 行のみ:
{
  "detected": boolean,
  "items": [{"name": string, "quantity": number?, "unit": string?}],
  "eaten_at_iso": string,      // ISO8601 JST 補正済
  "raw_text_excerpt": string,  // user の食事言及部分を抜粋 (debounce 比較用)
  "confidence": 0.0〜1.0,
  "reason": string             // 短い根拠
}

## 現在時刻 (JST)
2026-06-02 13:45:00

## 直近 3 ターン
[T1 user @ 2026-06-02 13:43] サンドイッチ食べた
[T1 yui ] 何が入ってるんですか?
[T2 user @ 2026-06-02 13:45] ツナレタス卵

## eaten_at_iso の決め方 (優先順位高→低)
1. 文中の明示的な時刻 ("9時に" "12:30") → そのまま採用
2. "今 / さっき / たった今" → 会話時刻
3. meal カテゴリ単独 ("朝ごはん"="今日 8:00" / "ランチ"="12:30" / "夕飯"="19:30" / "夜食"="22:30" / "おやつ"="15:00")
4. "昨日の◯◯" 等の日付ヒント → 該当日の上記標準時刻
5. それ以外 → 会話時刻 (= 現在時刻)
```

### 5.4 多ターン context

直近 3 turn pair = 6 messages を context window として extractor に渡す。
T1 で「サンドイッチ食べた」、T2 で「ツナレタス卵」と分けて言われても、まとめて 1 件のログとして抽出される。

### 5.5 confidence ガード

- `confidence >= 0.7` → 保存
- `confidence < 0.7` → スキップ + warn ログ (user に追加で聞かない、しつこく感じるので)

## 6. eaten_at 推定ルール (詳細)

| 発言例 (現在時刻) | eaten_at | 適用ルール |
|---|---|---|
| 「サンドイッチ食べた」(13:00) | 13:00 | 5: 会話時刻 |
| 「朝ごはん食べた」(8:30) | 今日 8:30 | 5 (3 より優先): 会話時刻が朝の範囲内なら自然 |
| 「朝ごはん食べた」(20:00) | 今日 8:00 | 3: 朝の標準時刻 |
| 「11 時に起きて**今** 朝ごはん食べた」(13:00) | 13:00 | 2: "今" 優先 |
| 「朝 9 時ごろに食べた」(20:00) | 今日 9:00 | 1: 明示時刻優先 |
| 「昨日の夜ラーメン」(10:00) | 昨日 19:30 | 4: 昨日 + 夜 |
| 「明日の朝ごはん何にしようかな」(22:00) | (検出なし) | 未来形 |

## 7. 栄養 lookup

### 7.1 正規化

```
toNormalizedName("唐揚げ") = "からあげ"
toNormalizedName("ツナサンドイッチ") = "つなさんどいっち"
toNormalizedName("ご飯 茶碗1杯") = "ごはん"
```

ひらがな化 + 空白潰し + 数量除去 で cache hit 率を稼ぐ。完全に同一化できないが、まずは粗くて OK。

### 7.2 lookup 順序

1. `food_reference` テーブルを `normalized_name` で SELECT
   - hit → 即返
   - miss → 次へ
2. SearxNG で「<name> カロリー 100g 栄養」検索
3. 上位 3 件のスニペットを Gemma に渡して `{kcal, protein, carbs, fat, fiber, unit, confidence}` を抽出
4. 結果を `food_reference` に INSERT (失敗時も次回再試行)

### 7.3 精度の現実

- LLM + web 抽出の精度は ±20-30% 程度。料理 (定食) は更に幅広い
- これは Yui の口調で「だいたい」「目安」「概算」を必ず添えて user の認知を制御
- 個別ヤバい誤差はあとで user が訂正できる UI (Phase 2)

### 7.4 quantity の扱い

```
{"name": "サンドイッチ", "quantity": 1, "unit": "個"}
→ food_reference 「サンドイッチ」kcal_per_unit = 300 (unit="個")
→ 1 × 300 = 300 kcal
```

`quantity` が無い場合 (省略) は 1 とみなす。

## 8. Yui の返答経路

Phase 1 では **Yui は食事ログを意識しない**。普通に応答するだけ (screenshot のように "あら、サンドイッチですか" と相槌)。

Phase 3 で:
- Yui に `getFoodLogToday` tool を渡して、「これで今日 X kcal です」みたいに返せるようにする
- 朝の briefing で「昨日のトータル X kcal」を読み上げ

## 9. プライベートモードとの関係

- プライベートモード中は raw_messages に書かれない → food extractor も走らない (自然と除外)
- 食事ログを残したくない user は private モードに切替えれば OK (シークレットデート時等)

## 10. リスクと精度ガード

| リスク | 対策 |
|---|---|
| 「美味しそう」発言を誤って食事として記録 | 上記プロンプトで detected=false に分岐、confidence ガード |
| 二重記録 (T1/T2 分割発言) | debounce 5 分 |
| 栄養値の大きな誤差 | Yui 口調で必ず「概算」を添える、user 訂正経路 (Phase 2) |
| 大量データ蓄積 (5 年 × 5 件/日 ≈ 1 万件) | eaten_at index、items は jsonb で集計クエリは total_* 列で速い |
| 健康診断の代わりに使われる | Yui は「医療相談は医師へ」を要所で添える設計 (Phase 3) |

## 11. フェーズ計画

### Phase 1: schema + extractor + nutrition lookup
- food_logs / food_reference / body_metrics 3 テーブル新規
- post-turn food extractor (Gemma 1 回、debounce 5 分)
- 栄養 lookup (cache → SearxNG → Gemma 抽出 → cache 書き込み)
- chat/route.ts 統合 (fire-and-forget)
- 動作確認用に `GET /api/food/recent` (UI なし、JSON 返却のみ)

### Phase 2: メトリクス modal + 体重ログ
- 新規 modal 「ヘルス」or 既存 settings に統合検討
- 食事 timeline (日次 / 週次 / 月次)
- 体重ログの手動入力 (modal + チャット経由「今朝 72kg」も抽出対応)
- Yui に `getFoodSummary` tool 渡して chat で参照可能に

### Phase 3: Insights + 朝の briefing 統合
- 朝の briefing に「昨日 X kcal」「直近 7 日平均」を 1 行追加
- 週次振り返り: PFC バランス、kcal vs 体重トレンド、傾向コメント
- Yui の自発的声かけ ("最近記録少ないみたい、忙しい?")

### Phase 4: 写真 / 目標 / 外部連携
- メール添付 or アップロード写真 → 食事認識
- TDEE 目標設定、目標達成率
- Apple HealthKit / Garmin 連携 (運動・睡眠)
