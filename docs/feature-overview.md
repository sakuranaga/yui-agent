# 機能概要

Yui Agent の主要機能の bird's-eye view。各機能の詳細設計は個別 docs にあり、ここはそれぞれの 5-10 行サマリ + index としての役割。

---

## 1. 会話と人格

- **メインモデル** (= Yui 本体): デフォルト Claude Sonnet 4.6、`/setup` で任意の provider に切替可
- **サブモデル** (= voice 整形 / dispatch judge / news 評価 等): デフォルト Claude Haiku 4.5
- **ローカル LLM** (= Gemma 系) を `extract` / `reconcile` / `judge` / `tts_normalize` / `mail_curate` / `food_extract` / `intent` 等のサブ役割に割り当ててコスト圧縮
- 結衣 = 29 歳秘書としての一貫した人格 (= `src/app/api/chat/yui-prompt.ts`)
- 自己が AI / LLM であることは開示しない
- TTS: 自前 TTS サーバ (`TTS_URL`) に proxy、文単位で chunk 再生
- 表情変化 (= happy / sad / angry / relaxed / surprised) + TTS 駆動リップシンク
- **応答 sanitize**: assistant 出力に紛れた JST タイムスタンプ等を吹き出し / TTS / DB すべてから除去
- **TTS 辞書** (= `tts_dictionary` テーブル): 固有名詞・略語の読み方を DB で持って TTS 前に正規化、Haiku second-pass あり

---

## 2. Multi-provider AI 設定

- **4 provider** 統合: Anthropic / OpenAI / Gemini / Grok
- API key を provider 単位で登録、有効 / 無効切替
- **role 単位の差替**: 主モデル / 副モデル / extract / judge / curate ... 役割ごとに好きな model を選択
- OpenAI 経路では reasoning model (= `o3` 等) にも対応 (= `reasoning_effort` 渡し)
- 詳細: `docs/ai-settings.md`

---

## 3. 環境アウェアネス (= 環境ブロック)

各ターンで Yui の system prompt に **「今の環境」ブロック** を注入:

| 情報 | ソース |
|---|---|
| 日時 (= JST 和暦 / 六曜 / 月齢) | サーバ時刻 |
| 天気 (= 温度 / 状態 / 湿度 / 降水確率) | Open-Meteo + 位置情報 |
| 週間天気 | `weather_daily` テーブル (= Calendar セル + popover に表示) |
| 流れている / 停止中の音楽 (= 曲名 / アーティスト / アルバム + isPlaying) | Spotify Web API (= 30s polling) |
| 進行中タイマー / リマインダー残時間 | `timers` / `reminders` テーブル |
| 今日の calendar event 一覧 | Google Calendar (= 連携時) |
| 他 surface の直近発話 (= Discord 等) | `raw_messages` 横断 |
| ユーザー状態 (= online / away / focus / private) | activity store |
| アバター現在モデル | `vrm_models` |

これにより Yui は「いま流れてるのモーツァルトですね」「タイマー残り 3 分です」等を特別な tool 呼び出し無しで直答できる。

---

## 4. ユーザー状態と通知の出し分け

- **4 状態**: `online` / `away` / `focus` / `private`
- ChatPanel ヘッダから手動切替 + 自動推定 (= 放置で away、集中モード継続中等)
- **集中モード**: 通知抑止 + 終了時に「離席 → 集中 → 離席 → online」遷移を Yui voice で announce
- **プライベートモード**: 会話は **DB に書かない** → Valkey overlay (= 24h TTL) に保持。記憶抽出 / 検索からも自動除外。設定 > データ tab から即時クリア可能

---

## 5. 通知 (= お便り) システム

- **Toast** (= TimerToast と同テイスト)、importance × user 状態 × kind のマトリックスで `mode` (= speak / notify / silent) を出し分け
- **Discord forward**: 重要度と Discord chat policy で並行配信
- **ベルアイコン**: 集中モード中は灰色で抑止、未読数バッジ
- **連続再生** (`POST /api/notifications/replay_all`): 未読を順に speak + report
- **朝のブリーフィング**: 9:00 JST (= env で変更可) に予定 / 期限近 todos / ニュース 3 件 / 未読メール 5 件を Yui voice (= web) + Discord text + ReportPanel (= markdown) で配信

詳細: `docs/notification-system.md`

---

## 6. 記憶 (= Memory v2)

**7 層コンテキスト構造** で会話に過去を持ち込む。詳細: `docs/memory-architecture.md`

### Layer 概要

| Layer | 内容 |
|---|---|
| L1 (= 常時) | env block (= 時刻 / 天気 / 音楽 / timer / 状態) |
| L2 (= always-on facts) | importance トップ N (= 10 件) を重要度ソートで固定注入 |
| L3 (= recent summaries) | 最近の session summary (= 時系列 3 件) |
| L4 (= semantic) | クエリ関連 chunk (= bge-m3 cosine + BM25 + 時間減衰 + MMR、上位 5 件) |

### 抽出 / 整合 / 観測

- **rolling extraction**: 8 ターン進むごとに後追い抽出
- **session-end extraction**: ユーザー発話に「またね」「おやすみ」等の終了サイン検知
- **reconciliation**: 新規 chunk と既存を比較、重複 / 矛盾を soft delete
- **decay**: 利用されてない chunk の importance を時間で減衰
- 設定 > 記憶 tab: chunk 一覧 / 編集 / 削除 / 新規追加 (= 種類・所有者・重要度・内容)

---

## 7. Specialists (= バックグラウンド調査員)

Yui ターン内では tool として呼ぶが、実体は非同期 background job:

| Specialist | Yui-facing tool 名 | 用途 | 連携先 |
|---|---|---|---|
| schedule | `ask_schedule_specialist` | Google Calendar 確認 / 予定追加 | GCal v3 REST |
| mail | `ask_mail_specialist` | Gmail 検索 / 要約 | Gmail v1 REST |
| music | `ask_music_specialist` | Spotify の検索 + 再生 + 楽曲解説 trivia | Spotify Web API + Web 検索 |

各 specialist は availability 自動 detect (= OAuth / API key 未設定なら tool 一覧から外れる)。

**二重応答防止 (= Haiku Judge)**: dispatch 前に Haiku judge が「env block で答え切れる?」を判定 → 不要なら physical skip。

`ask_*_specialist` は内部で `gmail_search` / `spotify_search_play` 等の細かい tool を呼ぶが、Yui main からは specialist 1 つに見える。

---

## 8. TODO / プロジェクト

`todos` + `projects` テーブル。Yui tool で CRUD。

- `state`: `backlog` / `in_progress` / `blocked` (= 確認待ち) / `done`
- 自由テキスト `tags TEXT[]` で横断ラベル
- Gantt 用 `start_at` / `due_at` / `completed_at`
- 旧 Plane data は `external_ref="WORK-42"` で保持、その名で検索可
- **TodoModal**: 2 ペイン game-style、project chip クリックで絞込、検索バー、期限超過バッジ、日付ピル ↔ mini-calendar picker

---

## 9. Calendar

- **Google Calendar 完全同期** (= CalendarModal)
- 月 / 週ビュー、project 紐付け chip、終日イベント、複数日跨ぎ
- 「今日」ボタン、event 詳細 popover
- 5 分 periodic 同期 + 週間天気を月セルに重ね表示

---

## 10. Diary (= 1 日 1 エントリ)

- 寝る前に Sonnet で当日要約 (= `diary-write` periodic)
- **Catch-up logic**: 前日分が未書きなら次回起動時に補完
- **DiaryModal**: 1 ページリーダ + Zen Kurenaido フォント + TTS 読み上げ
- 設定 > データ tab から day 単位で削除 / 再生成可能

---

## 11. Contacts (= 簡易 CRM)

- VCF import、soft delete
- **ContactsModal**: TodoModal と同テイストの 2 ペイン
- 連絡先からの intent → TODO / 予定 / メール送信 が可能

---

## 12. Mail (= Gmail 統合 + 自動分類)

### 受信パイプライン

- **Phase A**: 5 分 periodic で Gmail poll
- **Phase B**: 本文 fetch
- **Phase C**: MailModal UI (= タブ / 複数選択 / SSE push / blocked / VIP) + 設定タブ
- **Phase D**: Compose Modal (= 送信 / 下書き保存 / 校正 / 返信生成)

### Mail Classification

- **RAG ベース per-mail score**: 学習例ベクトル + Gemma カテゴリ判定
- **学習モーダル**: バッジクリックで「これは重要」「不要」等を upsert
- **訂正ループ**: バッジで「違う」訂正 → 既存学習例を UPDATE → RAG に反映
- **自動アクション**: 学習ヒット + consent 三重ゲートで TODO 起票 / 予定追加を自動化
- 設定 > メール tab: VIP / ブロック / 興味プロファイル / 学習例管理

詳細: `docs/mail-system.md`, `docs/mail-classification.md`

---

## 13. News (= RSS キュレーション)

- 1 時間 periodic で RSS 6 ソース fetch、3 日 TTL、pinned は永続化
- **キュレーション**: Haiku scoring + Sonnet 発話 + 閾値以下 silent
- **配信**: NewsModal + 朝のブリーフィング + 「保存しといて」で pinned 化
- 設定 > ニュース tab で source 追加 / 削除 / 有効無効 + 閾値

詳細: `docs/news-curation.md`

---

## 14. ヘルス

詳細: `docs/health-tracking.md` (= Phase 1-6 全部)

- **食事ログ** (= Phase 1): 会話から post-turn extractor (= 5 分 debounce) で抽出 → 栄養 lookup → `food_logs`。`foods[]` 配列対応で「朝/昼/夜/おやつ」一気書きも複数行で保存。total_salt / total_fiber 含む全 PFC 集計
- **体重 / 気分 / 体脂肪 quick-save** (= Phase 2): 明示メトリクス (`70kg` 等) を Yui 応答前に regex 即時保存 + 範囲チェック
- **ジム** (= Phase 3): `workout_logs` + `workout-extract.ts` + 8 部位 chip + `get_workout_history` tool
- **HealthKit 連携** (= Phase 5): `POST /api/health/import` (= `X-Health-Key` 認証) で歩数 / 活動 kcal / 心拍 / SpO₂ / 睡眠時間を取り込み
- **履歴グラフ** (= Phase 6): HealthModal の 日次 / 週次 / 月次 view、日付 ◀▶ nav、体重 line + tooltip、食事 kcal bar、活動 sparkline、気分 dot chart
- **Phase 4 (= 服薬)** は保留 — リマインダー / habits 共通基盤 (= `reminders` テーブル) の上に乗せる予定

---

## 15. 睡眠サポート (= cognitive shuffle)

詳細: `docs/sleep-support.md`

- Luc Beaudoin の認知シャッフル理論を結衣声で再現
- 12 カテゴリ × ~3360 単語の image-evocative バンクから 10-20s 間隔で発話
- **囁き ref voice** + 文単位 chunk TTS で 7-15s の安定 whisper 再生
- 結衣の今日 1 日 (= 会話 / 完了 todo / 予定 / 日記) を素材に Sonnet で intro 生成
- アファメーション CRUD + 10% 確率注入
- **CC BY BGM** 5 曲 (= Chosic 配信) + ユーザ自前 upload (= `data/sleep-bgm/`)
- **WebAudio スリープ越し timer**: PC ディスプレイスリープでも timer 通り BGM 停止
- セッション中は「集中」自動切替で通知抑止、終了で「離席」

---

## 16. 音楽 (= Spotify)

- Spotify Web API + Spotify Connect で外部デバイス (= Spotify アプリ) の再生制御
- 「○○かけて」「次の曲」「止めて」「ボリューム上げて」音声 / テキスト両対応
- いま流れてる曲を Yui が直答 (= env block 経由、サーバ側 30s polling)
- **Free でも検索 / 「この曲なに?」までは動く**。再生制御 (= play / pause / next / volume) は Premium 必須
- 30s polling + SDK player_state_changed event で再生 / 停止状態を env block に反映 (= 「停止中の音楽」と「流れている音楽」を区別、Yui が pause を再生中と勘違いしない)
- 楽曲解説 trivia (= `ask_music_specialist` 内 `spotify_search_play` の戻り値) を ReportPanel に表示

詳細: `docs/spotify-setup.md`

---

## 17. VRM Wardrobe

- **Phase 1 ✓**: 複数 VRM 登録 (= upload) + サムネ自動生成 + 手動切替 (= リロード不要)
- 設定 > 見た目 > VRM ギャラリー
- **Phase 2 (= 未)**: 着替え時の walk-out / walk-in 演出
- **Phase 3 (= 未)**: 時刻ベース自動切替スケジュール

upload された VRM は `data/vrm-models/<id>.vrm` に保存 (= gitignored)。配布同梱は `public/girl.vrm` の 1 体のみ。

---

## 18. VRM 表示

| 層 | 何を動かすか | 担当 |
|---|---|---|
| 全身モーション | 立ちポーズ + (= 任意) アイドル | 手書き rest pose + VRMA |
| 二次運動 | 髪 / スカートの揺れ | スプリングボーン |
| 生命感 | 呼吸 / まばたき / lookAt / リップシンク | `src/components/VRMViewer.tsx` フレームループ |

- リップシンク: AnalyserNode の RMS 振幅 → 口形
- VRMA: `public/animations/idle.vrma` を置けば AnimationMixer で再生
- マウス追従 / ドラッグ回転 / スクロールズーム

---

## 19. Project Links (= 横断 M:N)

- 任意リソース (= todo / event / mail / diary / contact 等) を `projects` に紐付け
- ChipsEditor で「+」から add、Gemma 経由の AI suggest 付き
- **Project Hub Modal**: project 中心の集約 dashboard (= todos / events / mail / diary)

---

## 20. Intent エンドポイント (= cross-tool dispatch)

- Gemma 経由で発話を解釈し、最適な tool / modal に dispatch
- **Phase A ✓**: Mail → TODO 起票 + `artifact_links` back-link + dedup
- **Phase B ✓**: 全 cross-tool dispatch + 全 modal の back-link panel
- **追補 ✓**: 連絡先からの TODO / 予定 / メール送信

---

## 21. 好感度 (= Affinity)

設計のみ (= `docs/affinity-system.md`)、**未実装**。

- 日次曲線 (= Daily Mood Curve)、ギャップ瞬間 (= Mask Crack Events)、長期親密度の 3 軸

---

## 22. Tool 系統 (= Yui が直接使う)

| Tool | 用途 | 同期 / 非同期 |
|---|---|---|
| `web_search` / `web_fetch` | SearXNG ベース検索 / fetch | 同期 |
| `create_timer` / `cancel_timer` / `list_timers` | timer 管理 + on_fire_prompt | 同期 |
| `add_reminder` / `list_reminders` / `enable_reminder` / `disable_reminder` / `delete_reminder` | リマインダー / habits | 同期 |
| `add_todo` / `update_todo` / `complete_todo` / `delete_todo` / `list_todos` / `get_todo` / `search_todos` | TODO CRUD | 同期 |
| `list_projects` / `add_project` / `archive_project` | プロジェクト | 同期 |
| `add_contact` / `update_contact` / `find_contact` / `search_contacts` / `list_contacts` / `delete_contact` / `restore_contact` ... | 連絡先 | 同期 |
| `read_diary` / `search_diary` / `list_diary` / `write_diary_today` | 日記 | 同期 |
| `list_news` / `search_news` / `pin_news` / `unpin_news` | ニュース | 同期 |
| `get_food_summary` / `get_workout_history` | ヘルス参照 | 同期 |
| `set_health_goal` / `list_health_goals` / `disable_health_goal` / `delete_health_goal` | 健康目標 | 同期 |
| `get_route` | 道案内 | 同期 |
| `get_my_status` / `get_morning_brief` / `list_morning_briefs` | 状態 / briefing | 同期 |
| `music_pause` / `music_resume` / `music_next` / `music_prev` / `music_volume` / `music_now_playing` | Spotify transport (= 直接) | 同期 |
| `ask_*_specialist` (= mail / schedule / music) | 専門領域の調査 | 非同期 (= Haiku judge) |

---

## 23. 設定モーダル (= 11 タブ)

`SettingsModal` の game-style サイドバー:

| タブ | 内容 |
|---|---|
| 秘書 (persona) | persona 編集 (= `persona_settings` + prompt presets + mode_auto) |
| 見た目 (appearance) | テーマカラー (= 6 プリセット) + VRM ギャラリー (= upload / 切替 / サムネ生成) |
| プロジェクト (projects) | project マスタ CRUD |
| 連携 (integrations) | Google OAuth (= GCal / Gmail) + Spotify 連携 + Google Maps API |
| 通知 (notifications) | お便りマトリックス (= kind × user_state → mode) |
| ニュース (news) | RSS source 管理 + キュレーション閾値 |
| メール (mail) | キュレーション閾値 + 興味プロファイル + VIP / ブロック + 学習例管理 |
| 読み方 (dictionary) | TTS dictionary CRUD (= 固有名詞・略語) |
| 記憶 (memory) | memory_chunks 一覧 + 編集 + 削除 + 新規追加 (= 種類 / 所有者 / 重要度 / 内容) |
| AI | Multi-provider API key + role 単位の model 割当 + Embeddings + TTS |
| データ (data) | Valkey 会話履歴クリア + LLM ログ + 統計 + diary 削除 / 再生成 |

---

## 関連

- `docs/architecture.md` — システム構成
- `docs/data-persistence.md` — DB / Valkey / 埋め込み
- `docs/external-integrations.md` — 外部 API
- `docs/deployment-and-security.md` — HTTPS / 認証 / OAuth 暗号化
- `docs/roadmap.md` — 実装状況 + 残タスク
