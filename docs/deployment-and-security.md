# デプロイメント / セキュリティ

Yui Agent の HTTPS 構成、認証ゲート、SSRF 防護、エラー処理、OAuth at-rest 暗号化の解説。

---

## 1. Docker Compose 構成

`docker-compose.yml` の主要サービス:

| サービス | image | port | 用途 |
|---|---|---|---|
| `caddy` | `caddy:2-alpine` | `127.0.0.1:8443:443` | HTTPS 終端、リバプロ |
| `web` | build (= Next.js) | (= public 公開なし、Caddy 経由のみ) | アプリ本体 |
| `postgres` | `ankane/pgvector` | `127.0.0.1:5433:5432` | DB |
| `valkey` | `valkey/valkey:8-alpine` | (= 非公開) | Cache + queue + SSE bus |
| `searxng` | `searxng/searxng:latest` | `127.0.0.1:8888:8080` | 内部 Web 検索 |
| `discord-bot` | build (= apps/discord-bot) | (= 非公開) | Discord 連携 (任意) |

- **`web` は port を公開しない** (= LAN 直アクセス不可、必ず Caddy を経由)
- **Caddy のみ HTTPS で listen** (= 認証ゲートの「外側」を Caddy が、「内側」を middleware が担う)
- LAN 上の他端末からアクセスしたい場合は Caddy の bind を `0.0.0.0:443:443` 等に変えて HTTPS 証明書を整える (= 自己署名でも Let's Encrypt でも可、後述)

---

## 2. HTTPS / Caddy の構成 (= アクセス経路ごとに 5 案)

`Caddyfile` (+ ルータ / DNS / トンネル) を書き換えるだけで切替可能。**証明書の正当性 =
誰の認証局を信頼させるか**、と **アクセス経路 (= 端末 → どこを経由)** で 5 通り。

### A. ローカル単体 (= 既定、開発)

```caddy
localhost {
  tls internal
  reverse_proxy web:3000
}
```

- 自己署名証明書 (= Caddy の Local CA が auto 生成)
- **leaf cert は 12 時間で rotate**。1 度許可方式だと翌日また弾かれる
- 推奨: `docs/initial-setup.md` **Step 3-2** の手順で **root CA を OS の信頼ストアに登録**
  (= 1 回打てば 10 年間有効、leaf rotate を吸収)
- Mac は port 8443 (= compose `127.0.0.1:8443:443`)、Linux なら 443 公開も可
- bind は `127.0.0.1:8443:443` のままだと **同一マシンからしかアクセス不可**

### B. LAN 内マルチ端末 (= スマホ / タブレット から自宅サーバへ)

家の他端末 (= 192.168.1.10 みたいな private IP、または `mac.local` 等の mDNS hostname)
からアクセスしたい時。**self-signed のまま行く案**と **mkcert に乗り換える案**の 2 通り。

#### B-1. self-signed のまま、各端末に root CA を配る

```yaml
# docker-compose.yml の caddy ports 変更
ports:
  - "0.0.0.0:443:443"   # = LAN 内 全 host から到達可
```

```caddy
# Caddyfile を hostname / IP 両対応に
192.168.1.10 {
  tls internal
  reverse_proxy web:3000
}
mac.local {
  tls internal
  reverse_proxy web:3000
}
```

各端末で `caddy-root.crt` を信頼登録する必要がある:

- **iOS**: AirDrop / メールで `caddy-root.crt` を端末に送る → タップでプロファイル install
  → 設定 → 一般 → 情報 → 証明書信頼設定で有効化
- **Android**: Play Store の Files に置く → 設定 → セキュリティ → 詳細設定 → 証明書 →
  CA 証明書からインストール (Android 7+ は `network_security_config.xml` で chrome 側
  別途許可必要なケースあり)
- **他の Mac / Windows / Linux**: Step 3-2 手順を該当端末で

→ 端末増えるたびに 1 度の作業。ファミリーで共有用途なら現実的。

#### B-2. mkcert で「OS 信頼済み」CA を発行する

```bash
brew install mkcert
mkcert -install                  # = システム CA に mkcert root を登録
mkcert localhost 192.168.1.10 mac.local 127.0.0.1 ::1
# → localhost+4.pem / localhost+4-key.pem を生成
```

```caddy
:443 {
  tls /etc/caddy/certs/localhost+4.pem /etc/caddy/certs/localhost+4-key.pem
  reverse_proxy web:3000
}
```

```yaml
# docker-compose.yml の caddy volume
volumes:
  - ./certs:/etc/caddy/certs:ro
```

- mkcert は OS の root store と統合済みで installer も親切
- cert 生成時に複数 SAN (= ドメイン / IP) を 1 枚に同梱できる → スマホで `192.168.1.10`
  でも `mac.local` でも同じ cert で通る
- ただし他端末で開く時は **mkcert root を各端末に配る** ことになるので B-1 と手間は同じ

### C. Tailscale 経由 (= LAN 越え + cert 不要、推奨)

Tailscale 入れていれば、各端末で `tailscale cert` を打つだけで **本物の Let's Encrypt 互換 cert** が `.ts.net` ドメインに発行され、Tailscale net 内ならどこからでも HTTPS で
到達できる。証明書を端末に配る作業がゼロ。

```bash
# サーバ側で 1 度
sudo tailscale cert yui.tail-xxxx.ts.net
# → /var/lib/tailscale/certs/ に fullchain.pem + privkey.pem
```

```caddy
yui.tail-xxxx.ts.net {
  tls /var/lib/tailscale/certs/yui.tail-xxxx.ts.net.crt
      /var/lib/tailscale/certs/yui.tail-xxxx.ts.net.key
  reverse_proxy web:3000
}
```

または Caddy の `tls internal` のまま `tailscale serve` 経由でも可 (= Tailscale 側が
HTTPS を立てて 内部の Caddy に proxy)。

- 個人 / 小規模チーム用途では **最もシンプル**: 端末側に何も入れずに HTTPS が通る
- 外部公開はしない (= Tailscale net 内限定)

### D. Cloudflare Tunnel 経由 public 公開

Caddyfile はそのまま (= `tls internal`)。`cloudflared` を別途立ち上げ、Cloudflare Edge → cloudflared → ローカル Caddy のチェーン。

- user → Cloudflare Edge は **Cloudflare 管理の正式証明書が自動適用** (= 端末に cert
  install 不要)
- Cloudflare → ローカル Caddy は自己署名で OK (= Cloudflare 側で許容、`origin certificate`
  オプションで CF 発行 origin cert に差し替えも可)
- ドメインの DNS は Cloudflare 管理下にある必要あり
- 通信は Cloudflare 経由なので CF が中間にあることに同意できるなら最も楽

### E. 自宅サーバ直接公開 (= ルータ port 443 開放 + DDNS / 独自ドメイン + LE)

```caddy
yui.example.com {
  tls user@example.com
  reverse_proxy web:3000
}
```

- Let's Encrypt 自動取得 + 自動更新 (= Caddy ネイティブ機能)
- **独自ドメイン + DNS A record + port 443 の外部開放** が前提
- 公開する以上、認証ゲート (`AUTH_TOKEN`) は brute-force に晒される → 256-bit random 必須
- ルータの port forward + DDNS (= `duckdns.org` 等) との組合せが一般的

### 構成比較表

| 構成 | 端末側の cert 作業 | 公開範囲 | 設定難易度 | 推奨用途 |
|---|---|---|---|---|
| A. ローカル単体 | サーバ機 1 台のみ | 同一マシン | ★ | 開発 |
| B-1. self-signed LAN | 各端末で root CA install | LAN 内 | ★★ | 家族で共有 |
| B-2. mkcert LAN | 各端末で mkcert root install | LAN 内 | ★★ | B-1 より楽 |
| **C. Tailscale (推奨)** | **不要** (= Tailscale が処理) | Tailscale net | ★ | 個人 / 小規模 |
| D. Cloudflare Tunnel | 不要 (= CF 証明書) | public (= Cloudflare 経由) | ★★ | 公開 + CF 容認 |
| E. 自宅サーバ直公開 | 不要 (= LE) | public 完全直結 | ★★★ | フルコントロール公開 |

---

## 3. 認証ゲート

### 設計

`src/proxy.ts` (= Next 16 で `middleware.ts` からリネーム) が全 `/api/*` と全ページに認証を強制する。

- `AUTH_TOKEN` env が未設定なら **503** を返す (= 配布物として「認証バイパス事故」を防ぐ意図)
- cookie `vroid-auth` (= `AUTH_TOKEN` と同値) で認証
- 内部呼び出し (= Discord bot / cron 内 self-fetch) は `X-Internal-Auth: <AUTH_TOKEN>` ヘッダで通過
- iOS Shortcut → `/api/health/import` は **`X-Health-Key: <HEALTH_INGEST_KEY>` で別経路認証** (= cookie が扱えない UX 制約のため `PUBLIC_PATHS` 入り)

### PUBLIC_PATHS (= 認証不要 path)

- `/auth` (= ログイン画面そのもの)
- `/api/auth/login`, `/api/auth/logout`
- `/api/health/import` (= 上記の HealthKit Shortcut 経路)
- `/api/auth/google/callback`, `/api/spotify/callback` (= 外部 IdP からの cross-site redirect、SameSite=Strict cookie が落ちるため public 化、CSRF は state cookie 比較で防ぐ)
- `/favicon.ico`, `/_next/*` (= 静的アセット)

### Cookie 設定

- `HttpOnly` + `Secure` + `SameSite=Strict`
- 同タブの XSS / CSRF / cross-site から保護
- 比較は timing-safe (= SHA-256 で 32 byte に正規化してから定数時間 XOR、Web Crypto subtle.digest 使用で Edge / Node 両 runtime 対応、`src/proxy.ts` の `timingSafeEq`)

### Token rotate

`.env` の `AUTH_TOKEN` 書き換え → `docker compose restart web` → 全 session 失効

---

## 4. 初回セットアップ判定 (`/setup` 自動リダイレクト)

`page.tsx` が mount 時に `/api/setup/status` を fetch:

- AI provider key + main model + Embeddings が揃っているかを判定
- 未設定なら `router.replace("/setup")` で初回ウィザードへ
- 判定中は main UI を render しない (= 一瞬の表示 / 無意味な fetch を防ぐ)

`/setup` 自体は設定済みでも自由にアクセス可能 (= 上書き再設定運用)。

詳細: `docs/initial-setup.md`

---

## 5. OAuth at-rest 暗号化 (= Phase D1)

### 動機

OAuth refresh/access token を DB 平文で持つと、DB dump や file backup 漏洩で Google アカウント (Gmail / Calendar) や Spotify を直接乗っ取られる。これを **AES-256-GCM** で at-rest 暗号化する。

### 設計

- 鍵: `ENCRYPTION_KEY` env (= base64 32 byte、`openssl rand -base64 32` で生成)
- 暗号化ヘルパ: `src/lib/crypto.ts` の `encryptText()` / `decryptText()`
- フォーマット: `<version 1 byte> + <IV 12 byte> + <ciphertext> + <auth tag 16 byte>` を base64
- version byte で将来の鍵 rotation / アルゴリズム変更に備える

### スキーマ

`google_oauth_tokens` / `spotify_oauth_tokens` の 2 テーブル両方:

- `refresh_token` (= legacy plaintext、移行期のフォールバック)
- `access_token` (= legacy plaintext、同上)
- `encrypted_refresh_token` (= AES-256-GCM 暗号文)
- `encrypted_access_token` (= 同上)

新規書き込み (= OAuth 同意完了 / refresh フロー) は必ず `encrypted_*` 側のみに書き、plaintext 列は NULL に倒す。読み出しは encrypted 優先、無ければ plaintext fallback。

### 起動時自動 migration

`src/lib/oauth-token-migrate.ts` が startup の `tickMaintenance` first-run pass で:

- `encrypted_* IS NULL AND <plaintext> IS NOT NULL` な row を検出
- AES-256-GCM で encrypt → encrypted 列に書き
- plaintext 列を NULL に倒す

`ENCRYPTION_KEY` 未設定なら warn のみで skip (= 起動を失敗させない)。

### `ENCRYPTION_KEY` を失った時

既存連携トークンは復号不能になり、Google / Spotify の **再連携が必要**。`.env` を別途バックアップしておくこと。

---

## 6. エラー応答ヘルパ (= 例外メッセージ漏洩防止、Phase D3a)

### 動機

API ルートで上流例外 (= DB / 外部 API / network) の生メッセージを client に返すと、内部ホスト名 / 上流 API レスポンス本文 / DB ドライバ詳細 / SQL 断片 / stack 断片が漏れて偵察に使われる。

### `clientError(req, e, { ... })`

`src/lib/api-error.ts` の helper を**全 catch ブロックで使う**:

```ts
import { clientError } from "@/lib/api-error";

} catch (e) {
  return clientError(req, e, {
    status: 500,
    context: "mail/draft",          // server log にタグ付け
    message: "下書きの保存に失敗しました",  // client に返す固定文
  });
}
```

- **server log には full detail + stack** を `[api-error]` タグ付きで出力
- **client には `{ error: <安全な固定文> }`** を返す
- 上流の生メッセージは外に漏れない

### 既知エラーで status 分岐

`e.message` を inspect して status code を分けたい時は、**`msg` をローカル変数として branch 判定だけに使い**、レスポンスは clientError で返す:

```ts
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("403") || msg.includes("insufficientPermissions")) {
    return clientError(req, e, {
      status: 403,
      message: "Gmail 権限が不足しています。設定 > 連携 で再連携してください。",
    });
  }
  return clientError(req, e, { message: "送信に失敗しました" });
}
```

詳細は `CLAUDE.md` § エラーハンドリング。

### OAuth callback の redirect query

`/api/auth/google/callback` 等で失敗時、`?error=<msg>` を redirect URL に乗せると history / proxy log / ブラウザ拡張に残るので **固定文に丸める**。詳細は server log で追う。

### `errors[]` 配列を返す API (= bulk 処理)

`mail/poll` のように複数件処理の結果を `errors[]` で返す API でも同じ。`errors.push(e.message)` は NG。

---

## 7. SSRF 防護

### `safeFetch` (= `src/lib/safe-fetch.ts`)

外部 URL を叩く server-side コードは原則 `safeFetch` 経由:

- DNS 解決後 IP を検査、**private / loopback / link-local / metadata 範囲を拒否**
- IPv4-mapped IPv6 (= `::ffff:127.0.0.1` 等) も IPv4 として展開して判定 (= Phase A2 review fix)
- **リダイレクト手動追跡** + 各 hop で再検証 (= DNS rebinding / Location 誘導対策)
- size + timeout 上限
- 許可 hostname の env-based allowlist (= `SAFE_FETCH_ALLOWED_HOSTS=ollama-host,llm.internal,...`)

### `validatePublicUrl` (= `src/lib/url-validate.ts`)

DB に保存する URL (= 例: news source registration) は事前に `validatePublicUrl` で IP check してから保存。後で fetch する際に「保存時点では public、参照時点で内部 IP に rebind」を防ぐ二重防御。

### ESLint で raw fetch を禁止

`eslint.config.mjs` の `no-restricted-syntax` rule で **server-side の raw `fetch()` 呼び出しを禁止** (`error`):

- 外部 URL → `safeFetch` (= 推奨)
- 内部 self-call (= `http://localhost:3000/api/...`) → `internalFetch` (= `src/lib/internal-fetch.ts` で自動的に `X-Internal-Auth` 添付)
- 公式 SDK と同等の固定 hostname (= Google / Spotify / Anthropic 等公式 API) → 行頭に `// eslint-disable-next-line no-restricted-syntax -- <理由>` を付けて明示例外化

違反は `npm run lint` で検出。新規 fetch を生で書くと CI / 開発で赤くなる。

---

## 8. その他のセキュリティ対策 (= Phase D まとめ)

| 対策 | 場所 | 概要 |
|---|---|---|
| timer prompt injection 対策 | `src/app/api/chat/route.ts` | `source: "timer"` で発火する保存 prompt は `<timer_event>` ラップ + system guard + tool allowlist (= 副作用 tool 禁止) |
| Gmail header injection | `src/lib/gmail-send.ts` | CRLF / NUL を sanitize、From は連携済アカウントの allowlist |
| メール HTML XSS | `src/components/MailModal.tsx` | DOMPurify + iframe sandbox + CSP meta header |
| VRM / BGM upload validation | `src/app/api/vrm/models/route.ts`, `src/app/api/sleep/bgm/route.ts` | magic byte 検証 + 失敗時 DB row / file 両方 cleanup |
| debug route opt-in | `src/app/api/debug/reconcile/route.ts` | `ENABLE_DEBUG_ROUTES=1` env が無いと 404 |
| Spotify token refresh race | `src/lib/spotify.ts` | singleton promise で同時 refresh を 1 本に束ねる |

詳細: `CLAUDE.md` § 関連セキュリティ規約 + `SECURITY.md`

---

## 9. マイグレーション

### 起動時自動

`src/lib/startup.ts` の `tickMaintenance` first-run pass で:

- `src/db/migrate.ts` を呼んで `_migrations` table と照合
- 未適用の `src/db/migrations/*.sql` をトランザクション内で順次適用

### 手動

```bash
docker compose exec web npm run db:migrate
```

開発中の確認に。

---

## 関連

- `docs/initial-setup.md` — `/setup` ウィザード仕様
- `docs/architecture.md` — システム構成
- `docs/data-persistence.md` — DB スキーマ詳細
- `docs/external-integrations.md` — 外部 API 連携
- `CLAUDE.md` — 開発者向けセキュリティ規約 (= 全 catch で clientError 使用 等)
- `SECURITY.md` — 脆弱性報告ポリシー
