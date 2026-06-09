# 初回セットアップ

Yui Agent を `git clone` 直後から動かすまでの最短手順と、ブラウザ初回アクセス時に
出る `/setup` ウィザードの仕様。

---

## 必要なものの全体像

| カテゴリ | これだけで動く | 後から追加可能 |
|---|---|---|
| **環境変数 (.env)** | `AUTH_TOKEN`, `ENCRYPTION_KEY` | `GOOGLE_CLIENT_*`, `DISCORD_*`, `HEALTH_INGEST_KEY` 等 |
| **AI provider** | いずれか 1 つの API key (Anthropic / OpenAI / Gemini / Grok) | provider 追加 / role 別 model 設定 |
| **Embeddings** | Ollama (= 推奨、ローカル無料) or OpenAI 互換 API | カスタム埋め込みサーバ |
| **外部連携** | なし | Google OAuth (Calendar / Gmail) / Spotify / Discord bot / iOS Shortcut (HealthKit) |

---

## Step 1: `.env` 必須項目を作る

```bash
cd vroid
# 認証ゲート (= UI に入るための共有 token)
echo "AUTH_TOKEN=$(openssl rand -base64 32)" >> .env
# DB 暗号化キー (= OAuth refresh/access token を AES-256-GCM で暗号化する鍵)
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
```

**両方とも必須**。`AUTH_TOKEN` が無いとサーバが起動時に 503 を返す (= 配布物として「認証バイパス事故」を防ぐ意図)。`ENCRYPTION_KEY` が無いと OAuth 新規連携が失敗する (= encrypt 時に throw)。

鍵を失うと既存連携トークンは復号不能になり再連携が必要。`.env` を別途バックアップしておくこと。

その他の `.env` 項目 (= Google / Discord / HealthKit 等) は機能を使う時だけ。詳細は `docs/external-integrations.md`。

---

## Step 2: docker compose で起動

```bash
docker compose up -d
```

- 初回は build + npm install で数分。2 回目以降は named volume キャッシュで数十秒
- 自動で migrate も走る (= `src/lib/startup.ts` 経由)

---

## Step 3: Caddy root CA を OS に信頼登録 (= 強く推奨)

Caddy の `tls internal` が発行する **leaf cert は 12 時間で rotate** されるため、ブラウザの
「自己署名警告を 1 度許可」では翌日にまた弾かれる (= 一晩動かしっぱなしで起きるとエラー
だらけになる典型ケース)。**root CA を OS の信頼ストアに 1 度登録**しておくと、leaf cert が
何度 rotate しても自動で信頼され、ブラウザ警告自体が出なくなる。root CA は 10 年有効。

### Step 3-1: root CA を取り出す (全 OS 共通)

```bash
# macOS / Linux
docker compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > /tmp/caddy-root.crt
```

```powershell
# Windows (PowerShell)
docker compose exec -T caddy cat /data/caddy/pki/authorities/local/root.crt > $env:TEMP\caddy-root.crt
```

### Step 3-2: OS の信頼ストアに登録

**macOS** (system keychain):

```bash
sudo security add-trusted-cert -d -r trustRoot \
  -k /Library/Keychains/System.keychain \
  /tmp/caddy-root.crt
```

→ Chrome / Safari / Firefox など全ブラウザに反映。登録後 **Chrome は完全終了** (`Cmd+Q`)
してから再起動。

**Linux** (Debian / Ubuntu 系):

```bash
sudo cp /tmp/caddy-root.crt /usr/local/share/ca-certificates/caddy-root.crt
sudo update-ca-certificates
```

```bash
# RHEL / Fedora / CentOS 系
sudo cp /tmp/caddy-root.crt /etc/pki/ca-trust/source/anchors/caddy-root.crt
sudo update-ca-trust
```

これでシステム全体 (= curl, OS 標準) は通る。**Chrome / Edge は独自 NSS DB**を持つので
追加で:

```bash
sudo apt install libnss3-tools   # Debian/Ubuntu (RHEL は nss-tools)
certutil -d sql:$HOME/.pki/nssdb -A -t "C,," -n "Caddy Local Authority" -i /tmp/caddy-root.crt
```

Firefox は profile ごとに NSS DB を持つので、各 profile に同じ certutil を打つ:

```bash
for d in ~/.mozilla/firefox/*.default*/; do
  certutil -d sql:"$d" -A -t "C,," -n "Caddy Local Authority" -i /tmp/caddy-root.crt
done
```

**Windows** (管理者 PowerShell):

```powershell
Import-Certificate -FilePath $env:TEMP\caddy-root.crt `
  -CertStoreLocation Cert:\LocalMachine\Root
```

→ Edge / Chrome は Windows 証明書ストアを共有するのでこれだけで OK。Firefox は Windows
ストアを既定で読まないので、`about:config` で `security.enterprise_roots.enabled = true`
にするか、Firefox の設定 → 証明書 → 認証局証明書から手動 import。

### Step 3-3: ブラウザでアクセス

`https://localhost:8443` (= Mac の Caddy 高 port) または `https://localhost` (= Linux で
443 公開時) を開く。

1. **証明書警告は出ない** (Step 3-2 を済ませてあれば)。出る場合はブラウザを完全終了して
   再起動 + キャッシュ削除
2. `/auth` で `.env` の `AUTH_TOKEN` を貼り付け → cookie 保存
3. **AI / Embeddings 未設定なら `/setup` に自動リダイレクト**

### Step 3-3 を省略したい場合 (= 単発お試し)

警告を毎回クリックする運用でも動くが、leaf cert が 12 時間で rotate するので翌日に
また警告が出る。長期的には Step 3-2 を済ませること。

### LAN 内の他端末 (スマホ / タブレット) からアクセスしたい / 公開したい場合

本 doc は **サーバ機 = 自分のマシン** からアクセスする前提。下記の構成は別途設定が必要:

- LAN 内の他端末からアクセス → **Tailscale 経由が最も簡単** (端末側 cert 不要)
- 自宅外から public で → Cloudflare Tunnel or Let's Encrypt 直接公開

詳細は [`docs/deployment-and-security.md`](deployment-and-security.md#2-https--caddy-の構成--アクセス経路ごとに-5-案) 参照。

---

## Step 4: `/setup` ウィザード (= 初回オンボーディング)

「最低限動くために必要な設定」を 2 ステップで入力させる。

### Step 1: AI provider + API key

- **AI provider** (dropdown): Anthropic / OpenAI / Gemini / Grok
- **API key** (password input)

「次へ」を押すと、入力したキーで provider の `/v1/models` を叩いて利用可能な model 一覧を取得。

### Step 2: モデル + Embeddings

- **メインモデル** (= Yui 本体の応答に使う)
  - dropdown に provider の全 model が並ぶ + provider 推奨を pre-select
- **サブモデル** (= 抽出 / 分類 / 要約用、軽量)
- **Embeddings** (= memory 機能の前提)
  - **Ollama (推奨)** preset → URL `http://host.docker.internal:11434/v1/embeddings`, model `bge-m3`, dim `1024`
  - **OpenAI** preset → URL `https://api.openai.com/v1/embeddings`, model `text-embedding-3-small`, dim `1536`
  - **Custom** → 自分で URL / model / dim 入力

「セットアップ完了」で `/` (= main chat) に遷移。

### 再設定 (= 上書き運用)

`/setup` は設定済みでも自由にアクセス可能。現状の値を**上書き**するだけ。テスト用途や provider 切替に便利。

`/` → `/setup` のリダイレクトは**片道のみ**で、`/setup` から弾かれることはない。

---

## Step 5 (任意): 外部連携

`/setup` 完了後、Settings モーダル (= 右上の歯車) から個別に追加できる:

| 連携 | タブ | 必要なもの |
|---|---|---|
| Google Calendar / Gmail | 連携 | Google Cloud Console で OAuth client 作成。詳細: `docs/google-oauth-setup.md` |
| Spotify (= 音楽再生 / 検索) | 連携 | Spotify Developer Dashboard で App 作成。詳細: `docs/spotify-setup.md` |
| Discord bot (= text DM + SSE 受信) | (= `.env` 直接) | Discord Developer Portal で bot token 取得 |
| iOS HealthKit (= 歩数 / 心拍 / 睡眠) | (= `.env` 直接 + Shortcut 設定) | `HEALTH_INGEST_KEY` 生成 + iOS Shortcut 設定。詳細: `docs/health-tracking.md` Phase 5 |
| TTS サーバ (= 音声合成) | AI | 自前 TTS サーバを別 host で立てて `TTS_URL` 指定 |
| ローカル LLM (= Gemma 系 role 委譲) | AI | Ollama / llama.cpp 等 OpenAI 互換サーバ。`AI設定 → Local LLM` |

---

## トラブルシューティング

### ブラウザで証明書 warning が出続ける / 一晩経つと API が全部失敗する

Caddy `tls internal` の leaf cert は **12 時間で rotate** されるため、「一度許可」では
翌日にまた弾かれます (= `ERR_CERT_AUTHORITY_INVALID` で fetch 失敗 → console に
EnvironmentWidget や useUserState のエラーが大量に出る)。

**根本対応**: 上の **Step 3-2** で root CA を OS の信頼ストアに登録する。10 年有効の
root CA で leaf rotate を吸収できる。

**応急対応**: Chrome の「詳細設定 → このサイトに進む (安全ではありません)」を毎回クリック。
ただし翌日また同じ。

### `/auth` で「トークンが一致しません」

`.env` の `AUTH_TOKEN` 値を改行や前後空白なしで正確にコピペする。`docker compose up` 後の `.env` 変更は `docker compose restart` が必要。

### Embeddings を Ollama にしたが繋がらない

- Ollama を host で起動している場合: `http://host.docker.internal:11434/v1/embeddings`
- Linux で `host.docker.internal` が効かない場合: `docker-compose.yml` の web サービスに `extra_hosts: - "host.docker.internal:host-gateway"` を追加

### `/setup` を再表示したい

URL 直打ちで `https://localhost:8443/setup` に行けます。`/` から自動リダイレクトされるのは「未設定時のみ」、設定済みでも `/setup` 自体は自由にアクセス可。

---

## 関連

- `docs/external-integrations.md` — 外部統合 一覧
- `docs/deployment-and-security.md` — HTTPS / 認証 / OAuth 暗号化
- `docs/architecture.md` — システム全体構成
- `README.md` — プロジェクト概要
