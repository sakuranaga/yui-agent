# 外部統合

Yui Agent が連携する外部 API / サービスの一覧と、それぞれの認証経路 / 設定箇所。

---

## 概要

Yui Agent は **Yui を hub に各 API を呼ぶ Star パターン** (= `docs/architecture.md` 参照)。
外部統合は機能ごとに完全に独立しており、未設定なら関連 tool は Yui の tool 一覧から自動で外れる (= availability detect)。

| サービス | 用途 | 認証方式 | 設定箇所 |
|---|---|---|---|
| Anthropic Claude | メイン / サブモデル (= 推奨) | API key | `/setup` ウィザード or 設定 > AI |
| OpenAI | 代替 LLM provider | API key | 設定 > AI |
| Google Gemini | 代替 LLM provider | API key | 設定 > AI |
| xAI Grok | 代替 LLM provider | API key | 設定 > AI |
| Ollama (= ローカル LLM) | Embeddings + role 委譲 (= Gemma 等) | URL 指定のみ | `/setup` + 設定 > AI |
| Open-Meteo | 天気 / 週間天気 | 認証不要 | 自動 (= 位置情報を渡すだけ) |
| Apple Maps (= reverse geocode) | 位置 → 地域名 | 認証不要 (= ブラウザ Geolocation API) | 自動 |
| Google OAuth (= Calendar + Gmail) | カレンダー連携 + メール統合 | OAuth 2.0 | `.env: GOOGLE_CLIENT_*` + 設定 > 連携 |
| Spotify Web API | 音楽再生 / 検索 / now-playing | OAuth 2.0 | 設定 > 連携 (client id/secret) + OAuth フロー |
| SearXNG | Web 検索 (= 自前 instance) | 認証不要 (= 内部 docker network only) | docker compose 同梱 (image pull) |
| TTS サーバ | 音声合成 | URL + reference 音声指定 | 設定 > AI > TTS |
| Discord bot | DM / SSE 受信 | bot token | `.env: DISCORD_*` |
| iOS HealthKit (= Shortcut) | 歩数 / 心拍 / 睡眠 / 活動 取込 | カスタム header key | `.env: HEALTH_INGEST_KEY` + iOS Shortcut |
| Plane (= レガシー) | 旧タスク管理 | 廃止済 | (= ai_settings に残骸あり、機能としては停止) |

---

## 1. LLM provider 群

### 共通

- 全 provider の API key は DB (`ai_settings`) に保存 (= masked 表示)
- `/setup` ウィザードで provider + key + main/sub model を 1 ページで入力可能
- 後から設定 > AI タブで追加 / 切替 / role 別差替
- key は最初から暗号化されてはいない (= `ENCRYPTION_KEY` は OAuth refresh/access token 専用、AI provider key は別)

### Role 単位の差替

`anthropic_main_model` / `anthropic_haiku_model` のような単一カラムだが、内部では「main = Yui 本体」「sub = 抽出 / 分類 / 要約等の軽量タスク」として汎用化されている。

詳細は `docs/ai-settings.md`。

### Local LLM

Ollama / llama.cpp / LM Studio 等の **OpenAI 互換 API** を `local_llm_url` で指定。`local_llm_roles` に role 名を comma 区切りで列挙すると、その role は local LLM に逃げる:

例: `local_llm_roles=extract,reconcile,judge,tts_normalize,mail_curate,food_extract,intent`

---

## 2. Embeddings

| Preset | URL | model | dim |
|---|---|---|---|
| Ollama (推奨) | `http://host.docker.internal:11434/v1/embeddings` | `bge-m3` | 1024 |
| OpenAI | `https://api.openai.com/v1/embeddings` | `text-embedding-3-small` | 1536 |
| Custom | 任意 | 任意 | 任意 |

`/setup` ウィザードまたは設定 > AI > Embeddings で切替。同じ memory_chunks に対して dim が変わる embed model に乗り換えると整合性が壊れるので注意 (= 移行時は memory 全削除 + 再生成が必要)。

---

## 3. Google OAuth (= Calendar + Gmail)

### 必要なもの

- Google Cloud Console で OAuth 2.0 Client ID を作成
  - Authorized redirect URI: `https://localhost:8443/api/auth/google/callback` (= 開発時、本番は環境に合わせて)
- `.env` に `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` / `GOOGLE_CLOUD_PROJECT` を記入

詳細手順: `docs/google-oauth-setup.md`

### トークンの保存

OAuth で取得した refresh/access token は `google_oauth_tokens` テーブルに **AES-256-GCM 暗号化** で保存される (= Phase D1)。`ENCRYPTION_KEY` env が必須。詳細は `docs/deployment-and-security.md`。

### 必要 scope

```
openid email
calendar.events calendar.readonly
gmail.readonly gmail.send gmail.compose
cloud-platform
```

`cloud-platform` は Calendar / Gmail を OAuth ユーザートークンで叩く際に必要 (= 内部の data scope で実権限は制限される)。

---

## 4. Spotify

### 必要なもの

- Spotify Developer Dashboard で App 作成
- Redirect URI: `https://localhost:8443/api/spotify/callback` (= 開発時)
- 設定 > 連携 タブで Client ID / Client Secret を入力 (= integration_settings テーブルに保存)
- 「連携」ボタン → Spotify 同意画面 → callback で `/` に戻る

詳細: `docs/spotify-setup.md`

### Premium 制限

- 検索 / now-playing 取得は **Free でも動く**
- 再生制御 (= play / pause / next / volume) は **Premium 必須** (= Free で叩くと 403)
- Premium 未加入時の UI: `apiWorking: false, errorCode: "premium_required"` を /api/spotify/status が返す

### Token at-rest 暗号化

Google と同じく `spotify_oauth_tokens` テーブルに AES-256-GCM で暗号化保存される (= Phase D1)。

---

## 5. SearXNG

`docker-compose.yml` で `image: searxng/searxng:latest` を指定して **Docker Hub から自動 pull** される (= 本リポジトリには SearXNG のコード / バイナリは含まれない)。設定ファイル `searxng/settings.yml` のみリポジトリ管理。

- 内部ホスト名: `searxng:8080` (= web container から呼ぶ)
- host port: `127.0.0.1:8888:8080` (= デバッグ閲覧用、LAN 露出なし)
- 用途: `web_search` tool / news fetch / Yui の Web 知識取得

AGPL-3.0 の責務は SearXNG project 自身が負う。Yui Agent はそれを利用するだけで AGPL に汚染されない (= ライセンス詳細は `CREDITS.md`)。

---

## 6. TTS サーバ

### 推奨: Irodori TTS

[Aratako/Irodori-TTS](https://github.com/Aratako/Irodori-TTS) (= MIT License、Voice Design 機能で seed から voice 合成可能) を別ホスト or 同居で立てる。

### 設定

- 設定 > AI > TTS で URL + reference 音声パスを指定
- repo 同梱 reference: `assets/tts-refs/cool_seed_7777.wav` (= 通常会話用) / `whisper_ref.wav` (= 睡眠サポート用)
- TTS サーバ側にこれらを copy or download して、AI 設定で**絶対パス**を入力

### TTS 辞書

`tts_dictionary` テーブルに固有名詞・略語の読み方を登録。TTS 前段で正規化される。「設定 > 読み方」タブで CRUD。

---

## 7. Discord bot

### 必要なもの

`.env` で:

```
DISCORD_BOT_TOKEN=<bot token>
DISCORD_OWNER_ID=<your Discord user id>
DISCORD_SESSION_ID=<任意の UUID 1 つ固定>
```

### 動作

- Discord text DM を Yui に流す経路 (= text 経由で会話可能)
- お便り (= 朝のブリーフィング / 重要通知) を Discord text に forward
- Yui の SSE 通知を bot 経由で受信

詳細: `apps/discord-bot/src/index.ts` のヘッダコメント参照。

---

## 8. iOS HealthKit (= Shortcut)

### 必要なもの

`.env` で:

```
HEALTH_INGEST_KEY=$(openssl rand -hex 16)
```

### iOS Shortcut

iOS の Shortcut アプリで「歩数 / 心拍 / SpO₂ / 睡眠時間」を JSON にまとめて POST する設定:

- URL: `https://<your host>/api/health/import`
- Header: `X-Health-Key: <HEALTH_INGEST_KEY>`
- Body: HealthKit から取得した最新値の JSON

詳細: `docs/health-tracking.md` Phase 5 補足

`/api/health/import` は `PUBLIC_PATHS` に含まれていて AUTH_TOKEN 不要 (= 代わりに `X-Health-Key` で別経路認証)。これは iOS Shortcut が cookie を扱えない UX 制約のため。

---

## 9. Plane (= レガシー、廃止済)

旧バージョンの Yui は Plane (= セルフホスト OSS タスクツール) を `task` specialist 経由で叩いていたが、自前 `todos` テーブル + UI に完全移行済で**現在は使われない**。残骸: `ai_settings` の Plane 関連 key (= 残ってるだけで参照されない)。

---

## 関連

- `docs/initial-setup.md` — 初回セットアップウィザード
- `docs/deployment-and-security.md` — OAuth at-rest 暗号化詳細
- `docs/ai-settings.md` — Multi-provider AI 設定
- `docs/google-oauth-setup.md` — Google OAuth セットアップ
- `docs/spotify-setup.md` — Spotify セットアップ
- `docs/health-tracking.md` Phase 5 — HealthKit / iOS Shortcut
- `CREDITS.md` — SearXNG / 各 OSS の license
