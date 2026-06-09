# データ永続化

Postgres + pgvector + Valkey + 埋め込みサーバの役割分担とテーブル構成、マイグレーション運用。

---

## 1. Postgres + pgvector

Docker image `ankane/pgvector:latest`、内部ホスト名 `postgres`、port `5432`。
host から psql / inspection するため `127.0.0.1:5433` に bind (= LAN 露出なし)。

### スキーマ管理

- 全 schema は Drizzle ORM (`src/db/schema.ts`) で TypeScript として型付け
- migration は手書き SQL (`src/db/migrations/*.sql`) で applied 順は filename の連番
- 適用順は `_migrations` テーブルで idempotent 管理 (= 同じ file は 2 度走らない)
- 起動時に自動 migrate (`src/lib/startup.ts` → `migrate.ts`)
- 手動なら `docker compose exec web npm run db:migrate`

### 主要テーブル (= 55 テーブル、64 migration、2026-06 時点)

#### 会話 / 記憶

| テーブル | 用途 |
|---|---|
| `raw_messages` | 全発話を逐語的に永続化 (session_id 紐付け、削除無し) |
| `extraction_progress` | session ごとの memory 抽出進行位置 |
| `memory_chunks` | 構造化された記憶 (= fact / preference / event / emotion / summary / turn_summary / commitment / procedural / external_ref / task_result) + bge-m3 1024 次元 vector + owner 分離 (ご主人様 / 結衣 / 共有) |
| `decay_runs` | memory_decay の実行ログ (= histogram, processed/decayed/invalidated 統計) |
| `retrieval_log` | retrieval observability (= どの chunk が hit したか) |
| `user_profile_snapshots` | 1 日 1 回生成されるご主人様プロファイル要約 |

#### ユーザー設定 / 認証

| テーブル | 用途 |
|---|---|
| `persona_settings` | 結衣の人格・モード (single-row、id=1) |
| `prompt_presets` | persona 追加プロンプトのプリセット (複数登録、1 つだけ active) |
| `ai_settings` | Multi-provider API key / role 別 model 割当 / Embeddings 設定 |
| `tts_dictionary` | TTS 読み方辞書 (固有名詞・略語) |
| `user_location` | reverse-geocode 済の地域名 (= 緯度経度は env block に渡さない) |
| `notification_settings` | お便りマトリックス (kind × user_state → mode) |
| `vrm_settings` | デフォルト VRM の current id 等 |
| `integration_settings` | Google Maps API key / Spotify client id/secret 等の外部 key/value |

#### OAuth (= Phase D1 で at-rest 暗号化、AES-256-GCM)

| テーブル | 用途 |
|---|---|
| `google_oauth_tokens` | Google (Calendar / Gmail) の refresh/access token (= `encrypted_*` 列に AES-256-GCM 暗号化保存、plaintext 列は移行期のフォールバック用) |
| `spotify_oauth_tokens` | Spotify の refresh/access token (= 同上) |
| `gmail_accounts` | 連携済 Gmail アカウントの enabled / sync 状態 |

詳細は `docs/deployment-and-security.md` § OAuth 暗号化。

#### Tasks / TODO / Reminders / Timers

| テーブル | 用途 |
|---|---|
| `tasks` | 旧 Plane data + specialist 実行記録 (= jobs / dispatch 履歴) |
| `timers` | タイマー / アラーム + `on_fire_prompt` |
| `todos` | TODO 管理 (state: backlog / in_progress / blocked / done、tags TEXT[]、Gantt 用日付) |
| `projects` | プロジェクトマスタ |
| `reminders` | 期日リマインダー / habits 共通基盤 |
| `job_claims` | atomic な周期ジョブ claim (= INSERT ON CONFLICT DO NOTHING) |
| `periodic_state` | periodic module 別の前回実行 state |
| `proactive_state` | proactive 系の状態 (= 設計のみ、未実装) |

#### コミュニケーション

| テーブル | 用途 |
|---|---|
| `contacts` | 連絡先 CRM (VCF import 対応、soft delete) |
| `mail_messages` / `mail_attachments` | Gmail 受信本文 + 添付 |
| `mail_curation_settings` | 興味プロファイル + 閾値 |
| `mail_training_examples` | RAG 学習例 (= ベクトル + ラベル) |
| `notifications` | お便り通知 |
| `morning_briefs` | 朝のブリーフィング履歴 (= 9:00 配信記録) |

#### News / 天気

| テーブル | 用途 |
|---|---|
| `news_sources` | RSS source 設定 |
| `news_articles` | RSS fetched article (= 3 日 TTL、pinned は永続) |
| `news_curation_settings` | キュレーション閾値 |
| `weather_daily` | 週間天気 (= calendar セル + popover 表示用) |

#### Diary

| テーブル | 用途 |
|---|---|
| `diary_entries` | 1 日 1 エントリの日記本文 (Catch-up logic 対応) |

#### ヘルス

| テーブル | 用途 |
|---|---|
| `food_logs` | 食事ログ (= items JSONB に複数 food 行、kcal/PFC/食塩/食物繊維 集計列) |
| `food_reference` | per-unit 栄養 cache (= 同じ食材を次回食べた時の lookup) |
| `body_metrics` | 体重 / 体脂肪 / 気分 等の scalar/daily 指標 |
| `workout_logs` | ジム記録 (= 8 部位、種目別 sets) |
| `health_goals` | 体重 / 栄養目標 (= one_time / daily_min / daily_max) |

#### Music

| テーブル | 用途 |
|---|---|
| `music_track_history` | Spotify 再生履歴 (= 30s polling で変化検知 + container 紐付け) |

#### Sleep

| テーブル | 用途 |
|---|---|
| `sleep_categories` | 認知シャッフルの 12 カテゴリ |
| `sleep_words` | カテゴリ別の image-evocative 単語 (~3360 件) |
| `sleep_affirmations` | アファメーション (= ユーザ CRUD) |
| `sleep_settings` | 睡眠サポートの設定 (= TTS 速度 / 間隔 / 難易度 / BGM 音量 等) |
| `sleep_sessions` | 各睡眠セッションの開始 / 終了 / 集計 |
| `sleep_bgm` | BGM 一覧 (= preset 5 曲 CC BY + ユーザ upload、`is_uploaded` で識別、credit 列に attribution) |

#### VRM

| テーブル | 用途 |
|---|---|
| `vrm_models` | VRM model registry (= デフォルト同梱の girl.vrm + ユーザ upload) |

#### 横断 / メタ

| テーブル | 用途 |
|---|---|
| `project_links` | 任意リソース (todo/event/mail/diary/contact 等) を project に紐付ける polymorphic M:N |
| `artifact_links` | intent dispatch の back-link (= 「このメールから起票した TODO」等) |

#### ゲーム化 / 監視

| テーブル | 用途 |
|---|---|
| `like_events` | ハート送信履歴 |
| `xp_events` | XP 加算履歴 |
| `llm_events` | LLM call の usage / cost / duration ログ |

---

## 2. Valkey (= Redis 互換キャッシュ)

Docker image `valkey/valkey:8-alpine`、内部ホスト名 `valkey`、port `6379`。
maxmemory 256mb + LRU eviction。RDB / AOF なし (= 永続化しない cache + queue / pub-sub 専用)。

### 用途

| 用途 | TTL |
|---|---|
| AI 設定 cache (= ai_settings の hot path 用) | 30s |
| 統合設定 cache (= integration_settings) | 30s |
| 会話 overlay (= プライベートモード + SSE 由来 ephemeral 発話) | 24h |
| 食事 extract debounce key | 5 分 |
| SSE pub-sub (= specialist 完了通知 / notification fire を session_id 別に push) | 即時 |
| LLM model 一覧 cache | 1 時間 |

### host port 非公開

Valkey は **port を公開しない** (= LAN の既存 Redis :6379 と衝突しない + cache は internal 用途のみ)。コンテナ間からは `valkey:6379` で TCP 接続。

---

## 3. 埋め込みサービス

### bge-m3 (1024 次元) 推奨

Ollama (= `ollama pull bge-m3`) を別ホスト or `host.docker.internal` で起動して
`http://host.docker.internal:11434/v1/embeddings` を `/setup` で指定するのが最も
シンプル。

### OpenAI 互換 API も可

OpenAI 直 (= `text-embedding-3-small`, dim 1536) や自前 llama.cpp 風サーバも `/setup` の
「Custom」preset で同等に動く。

### batch + cache

`src/lib/embed.ts` が batch embed (= 複数 chunk をまとめて 1 リクエスト) + 1 時間 Valkey
cache (= 同じ text の再 embed をスキップ)。

---

## 4. マイグレーション運用

### 開発時

1. `src/db/migrations/00XX_<name>.sql` を作成 (= 連番、内容は手書き SQL)
2. `src/db/schema.ts` を対応する型に更新
3. `docker compose exec web npm run db:migrate` で適用 (= 起動時自動でも走る)
4. 適用済 migration は `_migrations` table の row として記録される (= 同じ file は 2 度走らない)

### Rollback

drizzle-kit / 手動 SQL での down migration は未整備。代わりに「新規 migration で逆方向を打つ」(= 例: column を追加した migration の逆は、別 migration で `ALTER TABLE ... DROP COLUMN`)。

### Postgres host 越え

開発 host から psql で覗くなら:

```bash
psql -h 127.0.0.1 -p 5433 -U vroid -d vroid
```

(= compose.yml で `127.0.0.1:5433:5432` に bind してある、5432 だと host の既存 PG と衝突するので 5433)

---

## 関連

- `docs/architecture.md` — リクエストフロー / Periodic / Star pattern
- `docs/deployment-and-security.md` — OAuth at-rest 暗号化詳細
- `docs/memory-architecture.md` — 記憶層の設計
- `CLAUDE.md` — エラー処理 / セキュリティ規約
