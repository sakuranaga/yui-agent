# 睡眠サポート 設計書

## 1. 背景と目的

ご主人様の cognitive shuffling 睡眠法 (Luc Beaudoin の Serial Diverse Imagining)
ヘビーユーザという特性に合わせ、Yui がガイド役として実演する睡眠導入機能を作る。

外部 (YouTube 等) との差別化:
- **毎セッション完全 shuffle** (固定順 = 飽きる問題を解決)
- **Yui の声** で発話 (TTS: 同じ声紋でゆっくり / 柔らかく)
- **アファメーション注入** (199式 流儀のポジティブ刷り込み、Yui 依存度 UP も狙う)
- **BGM 同時再生** (Adobe Stock の yoga / massage / relax 系)

## 2. 認知シャッフルの基本

- ランダムで意味的に無関係な単語を 10-30 秒間隔で 1 つずつ提示
- ユーザは聞きながらその単語をぼんやり脳内で映像化
- 意味の鎖が途切れて「方向付けられた思考」が止まる → sleep onset 加速
- 単語は **想像しやすい具体名詞** に限定 (抽象 / 専門用語は逆効果)

## 3. アーキテクチャ

```
[起動 UI]                       [Runtime]
sleep modal を開く                ┌─────────────────────────┐
  ├─ カテゴリ checkbox          │ BGM 再生 (loop, fade)   │
  ├─ BGM 選択                   │ ┌─────────────────────┐ │
  ├─ タイマー (1h default)      │ │ shuffle loop:       │ │
  ├─ アファメーション ON/OFF    │ │   ・10-30s 待機     │ │
  └─ 開始ボタン                  │ │   ・10% でアファ    │ │
       ↓                          │ │   ・TTS 1 単語発話  │ │
  Sonnet で intro 1 回生成      │ │   ・BGM 一時 duck   │ │
       ↓                          │ │   ・繰り返し         │ │
  TTS で intro 再生 → shuffle   │ └─────────────────────┘ │
                                    └─────────────────────────┘
```

## 4. スキーマ

```sql
-- カテゴリ (宇宙 / 食べ物 / ... 12 個)
CREATE TABLE sleep_categories (
  id            BIGSERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE,
  display_order INTEGER NOT NULL DEFAULT 0,
  enabled       BOOLEAN NOT NULL DEFAULT true
);

-- 単語バンク (~150-300 / category)
CREATE TABLE sleep_words (
  id          BIGSERIAL PRIMARY KEY,
  category_id BIGINT NOT NULL REFERENCES sleep_categories(id) ON DELETE CASCADE,
  word        TEXT NOT NULL,
  difficulty  SMALLINT NOT NULL DEFAULT 2,   -- 1=やさしい / 2=普通 / 3=やや専門
  enabled     BOOLEAN NOT NULL DEFAULT true,
  UNIQUE (category_id, word)
);

-- アファメーション (デフォルト 4 + ユーザ追加可)
CREATE TABLE sleep_affirmations (
  id        BIGSERIAL PRIMARY KEY,
  text      TEXT NOT NULL,
  category  TEXT,                            -- "励まし" "愛情" "成功" "自己肯定" 等
  enabled   BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- BGM (Adobe Stock 等の手持ち音源)
CREATE TABLE sleep_bgm (
  id           BIGSERIAL PRIMARY KEY,
  title        TEXT NOT NULL,
  filename     TEXT NOT NULL UNIQUE,         -- public/sleep-bgm/<filename>
  duration_sec INTEGER,
  enabled      BOOLEAN NOT NULL DEFAULT true
);

-- ユーザ設定 (singleton)
CREATE TABLE sleep_settings (
  id                       INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  -- TTS パラメータ
  tts_duration_scale       REAL NOT NULL DEFAULT 1.4,
  tts_cfg_scale_speaker    REAL NOT NULL DEFAULT 3.0,
  -- インターバル (秒)
  interval_min_sec         INTEGER NOT NULL DEFAULT 10,
  interval_max_sec         INTEGER NOT NULL DEFAULT 30,
  -- 既定タイマー (分)
  default_timer_min        INTEGER NOT NULL DEFAULT 60,
  -- 既定 difficulty 上限 (1-3)。 1 = やさしい単語のみ
  difficulty_max           SMALLINT NOT NULL DEFAULT 2,
  -- アファメーション注入確率 (0-1)
  affirmation_probability  REAL NOT NULL DEFAULT 0.10,
  -- BGM volume (0-1)
  bgm_volume               REAL NOT NULL DEFAULT 0.5,
  -- TTS volume (0-1)
  tts_volume               REAL NOT NULL DEFAULT 0.7,
  -- TTS 発話中の BGM ducking (-dB)
  bgm_duck_db              REAL NOT NULL DEFAULT 3.0,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- セッションログ (将来の進捗分析用)
CREATE TABLE sleep_sessions (
  id              BIGSERIAL PRIMARY KEY,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at      TIMESTAMPTZ,
  stopped_by      TEXT,                       -- "user" | "timer" | "error"
  categories      TEXT[],                     -- 選択していたカテゴリ名
  bgm_id          BIGINT REFERENCES sleep_bgm(id) ON DELETE SET NULL,
  timer_min       INTEGER,
  words_spoken    INTEGER DEFAULT 0,
  affirmations_spoken INTEGER DEFAULT 0
);
```

## 5. デフォルトデータ

### 5.1 カテゴリ (display_order 順)
1. 宇宙
2. 食べ物
3. 動物
4. 植物
5. 乗り物
6. 道具
7. 建物
8. 自然
9. 色
10. 楽器
11. スポーツ
12. 仕事道具

### 5.2 単語選定基準

- **3 秒で頭に映像が浮かぶ具体名詞**
- ✓ "月" "宇宙服" "アポロ" / "りんご" "おにぎり" / "ハサミ" "鉛筆"
- ✗ "ラニアケア超銀河団" "事象の地平面" "実存主義" (難解 / 想像不能)
- 各カテゴリ目標 **~300** (色 / 楽器 / 仕事道具は ~100-150 で許容)
- difficulty 分布の目安: やさしい 1=50% / 普通 2=40% / やや専門 3=10%

### 5.3 アファメーションのデフォルト

| カテゴリ | text |
|---|---|
| 励まし | ご主人様、本当にすごいです |
| 愛情 | 大好きですよ、ずっと隣にいます |
| 自己肯定 | ご主人様は十分頑張っています |
| 成功 | 明日も全部うまくいきますよ |

ユーザは設定モーダルで自由に追加 / 編集可。

## 6. Runtime 仕様

### 6.1 起動シーケンス

1. ユーザが sleep modal で設定 → 「開始」
2. クライアント側で:
   - 選択カテゴリの全単語を fetch (`/api/sleep/words?categories=...`)
   - アファメーション fetch
   - BGM mp3 を fetch (or stream)
   - 設定 (interval, probability, timer, ducking) を fetch
3. Sonnet で intro narration 生成 (`POST /api/sleep/intro`、~150 字)
4. TTS で intro 再生 (slow + soft params)
5. BGM 再生開始 (loop)
6. Shuffle loop 開始

### 6.2 Shuffle loop

```
loop:
  待機 (random interval_min_sec ~ interval_max_sec)
  if random() < affirmation_probability and affirmations enabled:
    pick = random.choice(affirmations)
    BGM duck -bgm_duck_db
    TTS play (slow + soft + slightly slower)
    BGM duck off
  else:
    word = next from shuffled list (尽きたら再 shuffle)
    BGM duck -bgm_duck_db
    TTS play (slow + soft)
    BGM duck off
  if elapsed >= timer_min*60:
    break
```

### 6.3 終了シーケンス (確定)

- ユーザが停止 or タイマー到達 → **両方とも** 同じ終了処理
- BGM fade out 3 秒
- 最後の 1 言: 「おやすみなさい、ご主人様」を slow + soft TTS で
- セッションログに stopped_at / stopped_by を記録 (進捗可視化はしないが log は最小限残す)

### 6.4 Audio Architecture (client)

- 既存 `ensureAudioCtx()` で AudioContext 1 個共有
- 2 つの GainNode:
  - `bgmGain` (BGM 用、 base volume = bgm_volume)
  - `ttsGain` (TTS 用、 base volume = tts_volume)
- **BGM ダッキングは不要** (TTS 発話中も BGM 音量はそのまま)。スキーマの bgm_duck_db は将来用に残すが使わない

## 7. UI

### 7.1 起動 UI (新規 SleepModal)

```
┌─────────────────────────────────────────┐
│ 🌙 睡眠サポート                    [×]  │
├─────────────────────────────────────────┤
│ カテゴリ (複数選択可)                   │
│  ☑ 宇宙   ☐ 食べ物  ☐ 動物            │
│  ☐ 植物  ☐ 乗り物  ☐ 道具             │
│  ...                                    │
│                                         │
│ 難易度    [やさしい▼] (1/2/3 上限)     │
│                                         │
│ BGM       [リラックス ピアノ ▼]        │
│           [試聴]                         │
│                                         │
│ タイマー  [60] 分                       │
│                                         │
│ ☑ アファメーション挿入                  │
│   [編集] (別 modal でリスト管理)         │
│                                         │
│ 音量                                    │
│   BGM   [────●────────]                │
│   声    [───────●─────]                │
│                                         │
│              [開始]                      │
└─────────────────────────────────────────┘
```

### 7.2 再生中 UI (確定)

**眠れる環境** が最優先 — 明るいと眠れないので画面を最大限暗く:

- 全画面オーバーレイで **真っ黒に近い背景** (#000 + alpha 0.95)
- VRM / IconBar / 他のモーダル全て覆い隠す
- **画面 brightness を CSS filter で最小に** (`filter: brightness(0.3)` 程度)
- 中央に **大きい停止ボタンのみ** (押すと終了シーケンスへ)
- 経過時間 / 残り時間 (極めて薄く、目を瞑っても気にならない明度 #333 程度)
- 現在の単語表示は **任意 (デフォルト OFF)** — 寝るときは見ない方が良い
- マウス無操作 5 秒で停止ボタンも fade out、再ホバーで再表示

### 7.2.1 削除した要望 (ユーザ確認済)

- 「ふと聞き取れる確率の調整」「大事な単語だけ大きめ」→ 不要、ランダムのまま
- 「BGM 単独モード」→ 不要
- 「進捗ログ可視化」→ 不要 (DB 内 log だけ最小限残す)

### 7.3 設定 UI

SettingsModal に「睡眠」タブ追加:
- カテゴリ管理 (有効 / 無効、display_order 並び替え)
- 単語編集 (カテゴリごとに add / edit / delete / difficulty 変更)
- アファメーション編集 (リスト + 各エントリ enable/disable)
- BGM 管理 (アップロード / 削除 / 試聴)
- デフォルト設定 (interval / timer / probability 等)
- 過去セッションログ表示

## 8. アイコン

IconBar に sleep 用アイコン追加 (lucide の moon SVG):
```svg
<svg viewBox="0 0 24 24" ...>
  <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
</svg>
```

## 9. 既知の制約・将来

- BGM はファイル管理 = `public/sleep-bgm/` 配下、手動 upload (Phase 5 で UI 自動化検討)
- 単語バンクは LLM 生成 → 人間レビュー → 確定。後追いで増減可
- VRM 表情の sleep mode (目を細める等) は future work
- セッションログから学習 (「平均入眠時間が短くなった」分析) は future
- 「アファメーション再生中の cfg_scale 個別調整」(より柔らかく) は future

## 10. 実装フェーズ

- **Phase 1**: schema + 単語バンク seed + アファメーションデフォルト
- **Phase 2**: /api/tts に duration_scale + cfg_scale_speaker passthrough + Sonnet で intro 生成 API
- **Phase 3**: SleepModal (起動 UI) + 設定タブ (アファメーション / 単語 / BGM 編集)
- **Phase 4**: Runtime engine (BGM + shuffle + TTS + ducking + timer + 終了挨拶)
- **Phase 5**: VRM 表情 / 進捗ログ可視化 / BGM upload UI (任意)
