# ファイル / URL セキュリティスキャン (= 専用コンテナ) 設計書

## 0. 本書の位置付け

### 0.1 既存設計との関係

- **`docs/mail-threat-detection.md`** §G6 で添付ファイル sandbox / マルウェア検出を Phase G6 として言及していたが、本書ではこれを **より広い「汎用ファイル / URL セキュリティスキャン」** として独立させる
- メール添付スキャンを最初のユーザだが、**将来のファイルボックス機能 / VRM upload 強化** からも同じスキャナを呼べる構造にする

### 0.2 設計の動機

メール脅威検出 (= `mail-threat-detection.md`) を真面目に作る以上、以下の重い処理は **web container から分離** すべき:

1. **ClamAV ウィルススキャン** — 数百 MB の DB、定期更新、CPU 負荷
2. **添付ファイル sandbox 実行** — 将来。untrusted code 実行は web と完全分離必須
3. **URL HEAD fetch + redirect 追跡** — 攻撃者の罠 URL を踏むので、network policy を絞った別 container が安全
4. **threat intel feed daily download + cache** — PhishTank / OpenPhish / URLhaus を毎日 GB 単位で pull する可能性、独立 lifecycle が必要
5. **WHOIS / RDAP query** — レート制限あり、共通の cache が必要
6. **ML 推論** — 将来。Python / GPU の別 stack を想定

これらを **`mail-security` コンテナ** にまとめ、web container は internal HTTP 経由で呼ぶ。

### 0.3 LAS (= `sakuranaga/local-ai-search`) からの踏襲

- `clamav/clamav:latest` Docker image を独立 service として起動
- TCP 3310 で `clamd` daemon を expose
- ClamAV 不在時は **非ブロッキング skip + warn** (= LAS の `antivirus.py` の "skipped" status と同じ)
- virus DB 更新は ClamAV 自身の `freshclam` で自動 (= 別 cron 不要)

LAS は Python (= `pyclamd`) だが、Yui は TypeScript (= web と統一)。Yui 側の ClamAV クライアントは `clamscan` npm package (= 後述、§3.2)。

### 0.4 関連スコープ

本書のスコープ内:
- mail-security コンテナの設計 (= Docker 構成、内部 service 一覧)
- 汎用 file scan API (= ファイル bytes → verdict)
- URL HEAD 解析 API (= URL → final domain / redirect chain / 危険ヒント)
- threat intel feed cache + 照合 API
- web container との通信 (= internal HTTP, 認証)
- 将来のファイルボックス / VRM upload からの再利用 contract

スコープ外:
- ファイルボックス機能自体の設計 (= 別 doc が必要、本書はそこから呼ばれる scanner だけを定義)
- ML 推論サーバ実装詳細 (= Phase G6+、本書では call interface だけ用意)
- 添付 sandbox の具体的実装 (= Cuckoo vs Firejail vs 自前 VM、Phase G6+)

---

## 1. 要件

### 1.1 機能要件

- **scanFile(bytes, filename) → ScanVerdict**: 任意の bytes をウィルススキャン、結果を 4 値 (clean / infected / skipped / error) で返す
- **scanUrl(url) → UrlVerdict**: URL の HEAD fetch + redirect 追跡 + threat intel 照合、危険判定を返す
- **queryThreatIntel(url) → ThreatIntelHit[]**: ローカル cache (PhishTank/OpenPhish/URLhaus) に対する URL 照合
- **refreshFeeds()**: Yui の既存 periodic trigger (= intervalMs ベース、§6.3) で 24h 毎に全 feed を pull + cache に格納
- web container からは **Docker internal network 経由** で呼ぶ (= `MAIL_SECURITY_URL=http://mail-security:8090`、host port publish なし、外部から直接 reach 不可)

### 1.2 非機能要件

- ClamAV 不在時は **scanFile** は skip + warn を返す (= mail-poll は止まらない)
- network policy で **mail-security コンテナの outbound を制限** (= feed download + WHOIS + URL HEAD のみ許可、内部 IP / 他コンテナへの lateral movement 禁止)
- web container と mail-security 間の通信は **内部認証ヘッダ** (`X-Internal-Auth` 等、既存の internal-fetch と同パターン)
- パフォーマンス: ClamAV scan 100MB ファイルで < 5 秒、URL HEAD で < 3 秒 (= 標準的目標)

### 1.3 スコープ外 (= Phase G6+、本書では interface だけ)

- 添付 sandbox の actual 実行 (= cuckoo sandbox / Firejail)
- 画像 ML (= brand logo 検出)
- 動画 / 音声 deepfake
- SBOM / dependency security
- 暗号化添付 (= S/MIME 復号は別問題、web 側に key)

---

## 2. アーキテクチャ

### 2.1 docker-compose 構成

```
docker-compose.yml
  ├── web              (既存、Next.js Yui 本体)
  ├── caddy            (既存)
  ├── postgres         (既存)
  ├── valkey           (既存)
  ├── searxng          (既存)
  ├── discord-bot      (既存)
  ├── clamav           (新規、clamav/clamav:latest)
  └── mail-security    (新規、TypeScript service)
```

### 2.2 mail-security コンテナの内部構成

```
mail-security:8090            (= HTTP server、internal-only)
  ├── POST /scan/file         (= ClamAV 経由ウィルススキャン)
  ├── POST /scan/url          (= URL HEAD + redirect + threat intel 照合)
  ├── POST /threat-intel/query
  ├── POST /threat-intel/refresh
  ├── GET  /health
  └── (将来) POST /sandbox/run
```

内部依存:
- ClamAV daemon (= TCP 3310、別 container)
- Valkey (= cache 共有、既存 valkey container)
- Postgres (= threat_intel_url_cache table の read/write、既存 postgres container)
- Outbound HTTPS (= feed download、WHOIS RDAP)

### 2.3 ネットワーク isolation

`docker-compose.yml` で:

```yaml
networks:
  yui-internal:
    driver: bridge
  yui-mail-security:
    driver: bridge
    internal: false   # outbound HTTPS は必要 (= feed download + ClamAV virus DB 更新)

services:
  web:
    networks: [yui-internal]
  postgres:
    networks: [yui-internal]
  valkey:
    networks: [yui-internal]
  clamav:
    networks: [yui-mail-security]   # freshclam が virus DB 取得するため outbound 許可
  mail-security:
    networks: [yui-internal, yui-mail-security]
    # web からは yui-internal で接続、ClamAV / 外部には yui-mail-security
```

これで:
- web → mail-security: yui-internal 経由 (OK)
- mail-security → clamav: yui-mail-security 経由 (OK)
- mail-security → 外部 HTTPS (= feed download / WHOIS / URL HEAD): outbound 許可
- **clamav → 外部 HTTPS (= freshclam の virus DB 更新)**: 限定 outbound 許可
  - 接続先は ClamAV 公式 mirror (`database.clamav.net`、`db.local.clamav.net` 等) に限定される (= ClamAV image 内設定)
  - virus DB 取得目的のみ、それ以外の外部通信は ClamAV daemon の機能上発生しない
  - lateral movement 防止: clamav は **`yui-internal` には参加しない** (= web / postgres / valkey 等の他 container にはアクセスできない)
- web → 外部 (= URL): mail-security 経由でしか叩けないように制限を強化可能 (= future、現状は web 自身も outbound 可能)

### 2.3.1 ClamAV outbound の許容理由と制約

ClamAV の virus DB (= main.cvd / daily.cvd / bytecode.cvd) は **頻繁な更新が必須** (= 1 日数回〜1 時間ごとに新シグネチャ追加)。`freshclam` daemon が image 内で自動起動し、ClamAV 公式 mirror から差分 DL する。これを止めると検出精度が急速に劣化する。

そのため:
- clamav container の **HTTPS outbound (= 443) は許可**
- 接続先は ClamAV 公式 mirror に事実上固定 (= freshclam の `DatabaseMirror` 設定)
- **`yui-mail-security` network 分離により `yui-internal` には参加しない** ため、Docker network レイヤで Yui の他 container (= web / postgres / valkey 等) には到達不可
- **ただし host LAN / RFC1918 宛 (= 同一 host の Docker bridge 外、自宅 LAN 全体、Tailnet 等) への outbound は Docker network 分離だけでは止まらない**。完全に止めるには §10.3 の iptables ルール / Docker network egress policy の追加設定が必要 (= 推奨、ただし運用負担あり、ご主人様の環境次第で判断)

つまり Docker network 分離は「他 Yui container には届かない」を保証する。「ホスト LAN まで完全遮断」したい場合は別途 iptables / network policy が必要。

### 2.4 web container → mail-security の認証

`X-Internal-Auth` header + secret パターンを踏襲。ただし **`AUTH_TOKEN` (= web の front-door 認証) とは別 secret** にする (= `INTERNAL_AUTH_TOKEN` を独立 env として固定):

```
.env:
  AUTH_TOKEN=...                # front-door cookie 認証 (= user → web、既存)
  INTERNAL_AUTH_TOKEN=...       # service-to-service (= web → mail-security、新規)
```

理由:
- 現行 `src/lib/internal-fetch.ts:14` は `AUTH_TOKEN` を `X-Internal-Auth` に流用している。これを mail-security でも同じく使うと、**mail-security 側で `INTERNAL_AUTH_TOKEN` が漏洩した場合に web の `/api/*` (= front-door) まで横展開可能** になる
- 2 つの secret に分離すれば、mail-security 漏洩は mail-security の機能範囲内に閉じ込められる
- web → mail-security の `internalFetch` 呼び出しは `INTERNAL_AUTH_TOKEN` を使う新 helper (= `securityFetch()` 等の薄い wrapper) で実装

**Phase S1 実装時の追加作業**:
- `.env.example` に `INTERNAL_AUTH_TOKEN=` を追加 (= 生成方法 `openssl rand -base64 32` を注釈)
- `src/lib/internal-fetch.ts` の `AUTH_TOKEN` 流用は **front-door 用途のみ維持**、service-to-service は新 helper に分離
- 万一 user が `INTERNAL_AUTH_TOKEN` を設定し忘れた場合、mail-security は 401 を返して fallback (= scanFile/analyzeUrl/queryThreatIntel すべて skipped を返す、Yui 全体は止まらない)

---

## 3. ClamAV service

### 3.1 docker-compose service 定義

```yaml
services:
  clamav:
    image: clamav/clamav:latest
    restart: unless-stopped
    profiles: ["security"]   # = opt-in 起動、`docker compose --profile security up` で起動
    volumes:
      - clamav_data:/var/lib/clamav    # virus DB
    healthcheck:
      test: ["CMD", "clamdcheck.sh"]
      interval: 30s
      timeout: 10s
      retries: 5
      start_period: 180s   # virus DB 初期 download に時間かかる
    networks: [yui-mail-security]
    # 外部公開なし (= mail-security からしか触れない)

  mail-security:
    # (= §7.4 で定義、同じく profiles: ["security"])

volumes:
  clamav_data:
```

**`profiles: ["security"]` を付ける理由**:
- ClamAV は virus DB 500MB-1GB + freshclam で帯域使用、開発環境では負担大
- `docker compose up` (= profile 指定なし) では起動しない、本番運用で `docker compose --profile security up -d` で初めて起動
- 起動しなくても Yui 全体は動作 (= scanFile が skipped を返す、§4.4 fallback)
- 公開後 OSS user は「メール機能を使う + 添付スキャンしたい」場合のみ profile を有効化、それ以外は web + postgres + valkey + searxng + discord-bot だけで軽量起動
- `mail-security` service も同じ profile に乗せて、両方一緒に起動 / 停止する

`freshclam` (= ClamAV の DB updater daemon) は image 内で自動起動。virus DB は 4 時間ごとに自動更新される。

### 3.2 mail-security 側の ClamAV client

`mail-security/src/services/clamav.ts`:

```ts
import NodeClam from "clamscan";

let clamPromise: Promise<NodeClam> | null = null;

async function getClam(): Promise<NodeClam> {
  if (!clamPromise) {
    clamPromise = new NodeClam().init({
      clamdscan: {
        host: process.env.CLAMAV_HOST ?? "clamav",
        port: parseInt(process.env.CLAMAV_PORT ?? "3310", 10),
        timeout: 120_000,
        active: true,
      },
      preference: "clamdscan",
    });
  }
  return clamPromise;
}

export type ScanVerdict = {
  status: "clean" | "infected" | "skipped" | "error";
  virusName?: string;
  scannedAt: string;        // ISO timestamp
  errorMessage?: string;    // status=error 時のみ、固定文 (= raw error は server log)
};

export async function scanBuffer(
  bytes: Buffer,
  filename: string
): Promise<ScanVerdict> {
  try {
    const clam = await getClam();
    const stream = await clam.scanStream(bytes);
    if (stream.isInfected) {
      return {
        status: "infected",
        virusName: stream.viruses?.[0] ?? "unknown",
        scannedAt: new Date().toISOString(),
      };
    }
    return { status: "clean", scannedAt: new Date().toISOString() };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // ClamAV 不在 / ping fail は skipped に降格 (= 非ブロッキング)
    if (msg.includes("ECONNREFUSED") || msg.includes("not respond")) {
      console.warn("[mail-security] ClamAV unavailable, skipping scan");
      return { status: "skipped", errorMessage: "ClamAV unavailable", scannedAt: new Date().toISOString() };
    }
    console.warn("[mail-security] ClamAV scan error:", msg);
    return { status: "error", errorMessage: "scan failed", scannedAt: new Date().toISOString() };
  }
}
```

注意:
- **ClamAV 不在は skipped** (= 必須機能でない、warn のみ)
- error の `errorMessage` は固定文 (= raw error は server log)
- LAS の `pyclamd` と同じ 4 値 status (= clean / infected / skipped / error) を維持

### 3.3 ファイルサイズ制限 + stream 化 (= メモリ負荷対策)

**問題**: 既存添付 route (`src/app/api/mail/[id]/attachment/[attachmentId]/route.ts:66`) は Gmail から取った本文を `arrayBuffer()` で丸ごとメモリに持つ。100MB 添付なら 100MB RAM × 同時アクセス数。scanFile を Buffer 前提で実装すると、web + mail-security の両方で同じ問題が再発する。

**対策**:
- **scanStream(stream, filename, sizeHint)** を primary API として設計、Buffer 版は `streamFromBuffer` でラップする secondary。web 側も mail-security 側も両方 stream で受け渡し
- ClamAV 側のサイズ上限 (= `MaxFileSize` / `StreamMaxLength`) と app 側の `MAX_SCAN_SIZE` を **同じ値で設定**、env で同期 (= デフォルト 50MB、設定可能)
- size 超過は **pre-scan で reject** (= `status: "skipped"` + `errorMessage: "file too large"`)、stream を最後まで読まない (= cancel)
- timeout: scan 全体で 120 秒、stream 読み取りで 60 秒、それぞれ AbortSignal.timeout で
- web 側 API route (= attachment download / mail upload) も同じく stream 化推奨 (= H1c で arrayBuffer() を Web Streams API に置換)

### 3.3.1 scan API の stream contract

```ts
// scanStream を primary に
export async function scanStream(
  source: ReadableStream<Uint8Array>,
  filename: string,
  opts?: { sizeHint?: number; timeoutMs?: number }
): Promise<ScanVerdict>;

// Buffer 版は内部で Web Streams に変換
export async function scanBuffer(
  bytes: Buffer,
  filename: string,
  opts?: { timeoutMs?: number }
): Promise<ScanVerdict> {
  if (bytes.byteLength > MAX_SCAN_SIZE) {
    return { status: "skipped", errorMessage: "file too large", scannedAt: new Date().toISOString() };
  }
  const stream = new Blob([bytes]).stream();
  return scanStream(stream, filename, { sizeHint: bytes.byteLength, ...opts });
}
```

mail-security 側 server は multipart upload を Web Streams で受け取り、`scanStream` に直接渡す (= 中間で Buffer 化しない)。

---

## 4. universal file scanner API

### 4.1 公開 API endpoint

```
POST /scan/file
  Content-Type: multipart/form-data
  fields:
    file:     ファイル bytes
    filename: 元ファイル名 (= log とログ用、scan に必須ではない)
  headers:
    X-Internal-Auth: <token>

  response (JSON):
    { status, virusName?, scannedAt, errorMessage? }
```

### 4.2 web container 側 client

`src/lib/file-scanner.ts` (web container 内):

```ts
import { internalFetch } from "@/lib/internal-fetch";

export type ScanVerdict = {
  status: "clean" | "infected" | "skipped" | "error";
  virusName?: string;
  scannedAt: string;
  errorMessage?: string;
};

export async function scanFile(
  bytes: Buffer,
  filename: string
): Promise<ScanVerdict> {
  try {
    const formData = new FormData();
    const blob = new Blob([bytes]);
    formData.append("file", blob, filename);
    formData.append("filename", filename);
    const res = await internalFetch(
      `${process.env.MAIL_SECURITY_URL ?? "http://mail-security:8090"}/scan/file`,
      { method: "POST", body: formData }
    );
    if (!res.ok) {
      return { status: "skipped", errorMessage: "scanner unavailable", scannedAt: new Date().toISOString() };
    }
    return (await res.json()) as ScanVerdict;
  } catch (e) {
    console.warn("[file-scanner] scan failed:", e instanceof Error ? e.message : e);
    return { status: "skipped", errorMessage: "scanner unavailable", scannedAt: new Date().toISOString() };
  }
}
```

非ブロッキング設計:
- mail-security 不在でも `skipped` を返す (= 機能が部分的に死んでも mail-poll は止まらない)
- raw error は server log、API caller には固定 status のみ

### 4.3 利用元 contract

このスキャナは **汎用** なので、以下の caller から再利用される:

| 利用元 | 呼び出しタイミング | エラー時の挙動 |
|---|---|---|
| **メール添付スキャン (= mail-threat-detection §G6)** | 添付付きメール受信時、本文 fetch 後 | `infected` なら threat_score 加算 (+5.0)、`skipped` なら reason 追加 |
| **ファイルボックス upload** (= 将来) | user upload 完了時 | `infected` なら upload reject、`skipped` なら警告バナーで「未スキャン」表示 |
| **VRM model upload** (= 既存強化) | 既存 magic byte check の後段で追加 | `infected` なら upload reject (= 既存 cleanup と統合) |
| **その他バイナリ取り扱い** | ad-hoc | 個別判断 |

scanner 側は caller を区別しない。caller 側が verdict を見て個別判断する。

### 4.4 ファイルボックス機能向けの仮設計

(= 本書スコープ外だが、将来統合の前提として記載)

将来 `file_storage` table を作る場合、各 row に:
- `scan_status TEXT` (= "clean" | "infected" | "skipped" | "pending")
- `scan_at TIMESTAMPTZ`
- `virus_name TEXT NULL`

upload 完了 → 非同期で `scanFile` → 結果を update。`scan_status = pending` の間は user に「スキャン中」を UI で表示。

---

## 5. URL HEAD 解析 service

### 5.1 公開 API

```
POST /scan/url
  body: { url, options?: { followRedirects?: number, timeoutMs?: number } }
  headers: X-Internal-Auth

  response:
    {
      finalUrl: string,
      redirectChain: string[],
      finalDomain: string,
      statusCode: number,
      contentType: string | null,
      threatIntelHits: ThreatIntelHit[],
      flags: UrlFlags,    // = Punycode / short URL / suspicious TLD 等
      scannedAt: string,
    }
```

### 5.2 実装方針

mail-security 内に `services/url-analysis.ts`:

```ts
import { fetch } from "undici";

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 5_000;
const ALLOWED_SCHEMES = new Set(["http:", "https:"]);

export async function analyzeUrl(rawUrl: string): Promise<UrlVerdict> {
  let url: URL;
  try { url = new URL(rawUrl); } catch { return { error: "invalid url" }; }
  if (!ALLOWED_SCHEMES.has(url.protocol)) return { error: "scheme not allowed" };

  // SSRF 防止: 内部 IP / localhost / link-local には絶対繋がない
  if (await resolvesToPrivateIp(url.hostname)) {
    return { error: "private network forbidden" };
  }

  const redirectChain: string[] = [rawUrl];
  let current = url.toString();
  let statusCode = 0;
  let contentType: string | null = null;

  for (let i = 0; i < MAX_REDIRECTS; i++) {
    const res = await fetch(current, {
      method: "HEAD",
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    statusCode = res.status;
    contentType = res.headers.get("content-type");
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const nextUrl = new URL(res.headers.get("location")!, current).toString();
      const nextHost = new URL(nextUrl).hostname;
      if (await resolvesToPrivateIp(nextHost)) {
        // redirect で内部 IP に誘導された → 即停止
        return {
          finalUrl: current, redirectChain, finalDomain: new URL(current).hostname,
          statusCode, contentType,
          threatIntelHits: [],
          flags: { redirectToPrivate: true },
          error: "redirect to private network detected",
        };
      }
      redirectChain.push(nextUrl);
      current = nextUrl;
    } else {
      break;
    }
  }

  const finalUrl = current;
  const finalDomain = new URL(finalUrl).hostname;

  // threat intel 照合
  const threatIntelHits = await queryThreatIntel([rawUrl, ...redirectChain, finalUrl]);

  // 静的 flag 検出
  const flags = collectFlags(rawUrl, finalUrl, finalDomain);

  return { finalUrl, redirectChain, finalDomain, statusCode, contentType, threatIntelHits, flags, scannedAt: new Date().toISOString() };
}
```

### 5.3 SSRF 防止

`resolvesToPrivateIp(hostname)` 実装:

```ts
import { lookup } from "dns/promises";
import { isPrivate } from "ip";  // npm package

async function resolvesToPrivateIp(host: string): Promise<boolean> {
  try {
    const records = await lookup(host, { all: true });
    for (const r of records) {
      if (isPrivate(r.address)) return true;
      // IPv6 link-local / loopback もチェック (= isPrivate がカバー)
    }
    return false;
  } catch {
    return true;  // 解決失敗は安全側に倒す
  }
}
```

ブロック対象:
- 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 (= RFC 1918)
- 127.0.0.0/8 (= loopback)
- 169.254.0.0/16 (= link-local)
- ::1, fe80::/10 (= IPv6 同上)
- 0.0.0.0, broadcast 等

これは既存の `src/lib/url-validate.ts` (= `validatePublicUrl`) と同等のロジックを mail-security 側にも持つ。共通化したい場合は npm `private-ip` 等を使う。

### 5.3.1 DNS rebinding 防止 (= undici dispatcher で IP pin)

**問題**: `resolvesToPrivateIp` で 1 回目の lookup を検証しても、`fetch()` 内部で再度 DNS resolve される。攻撃者が TTL=0 で DNS 応答を切替えれば、検証時には外部 IP、fetch 時には内部 IP に bind される (= DNS rebinding 攻撃)。

**対策**: hostname を IP に置き換えるのは NG (= HTTPS 証明書検証 / SNI / Host header が壊れる)。undici の **custom dispatcher** で「URL の hostname は維持、connect 時の IP は検証済 IP に pin」を実現する:

```ts
import { Agent, fetch } from "undici";
import { lookup } from "dns/promises";

async function safeHeadFetch(rawUrl: string, signal: AbortSignal) {
  const url = new URL(rawUrl);

  // 1 回 lookup して全 IP を列挙、private IP を含むなら reject
  const records = await lookup(url.hostname, { all: true });
  const publicIps = records.filter((r) => !isPrivate(r.address));
  if (publicIps.length === 0 || records.length !== publicIps.length) {
    throw new Error("private IP in DNS records");
  }
  const pinnedIp = publicIps[0].address;
  const pinnedFamily = publicIps[0].family;  // 4 | 6

  // custom Agent で connect 時に lookup を再実行せず、pin した IP を返す
  const agent = new Agent({
    connect: {
      lookup: (_host, _opts, cb) => {
        // _host は URL の hostname だが、ここで pin 済 IP を返す
        cb(null, pinnedIp, pinnedFamily);
      },
    },
  });

  try {
    return await fetch(rawUrl, {
      method: "HEAD",
      redirect: "manual",
      signal,
      dispatcher: agent,
      // hostname は URL のまま (= SNI / 証明書検証 / Host header に使われる)
      // 接続先 IP だけが pin される
    });
  } finally {
    await agent.close();
  }
}
```

ポイント:
- `URL.hostname` は元のまま保持 → HTTPS 証明書の subject 検証は正規に行われる
- `Host` ヘッダも元の hostname → 正規 vhost にルーティングされる
- connect 時の TCP 接続先だけが pin した IP → DNS rebinding で内部 IP に切替えられない
- 攻撃者が「外部 IP + 内部 IP 両方を返す DNS」を仕掛けた場合、`records.length !== publicIps.length` で reject (= 全 IP が public でなければ通さない、悲観的)

**redirect 追跡時の注意**: redirect chain の各段で同じ手順を実行 (= 各 hop で lookup + 全 public 確認 + IP pin + 接続)。redirect 先の hostname を都度この関数経由で解決する。

### 5.4 静的 flag 検出

`collectFlags(rawUrl, finalUrl, finalDomain)`:

```ts
function collectFlags(rawUrl: string, finalUrl: string, finalDomain: string): UrlFlags {
  const flags: UrlFlags = {};
  if (finalDomain.startsWith("xn--")) flags.punycode = true;
  if (KNOWN_SHORTENER_DOMAINS.has(finalDomain)) flags.shortener = true;
  if (BAD_TLDS.has(finalDomain.split(".").pop()!)) flags.badTld = true;
  if (/^https?:\/\/\d+\.\d+\.\d+\.\d+/.test(rawUrl)) flags.ipDirect = true;
  if (rawUrl.startsWith("http://") && finalUrl.startsWith("http://")) flags.noHttps = true;
  if (rawUrl !== finalUrl) flags.redirected = true;
  return flags;
}
```

リスト (`KNOWN_SHORTENER_DOMAINS`, `BAD_TLDS`) は hard-coded で MVP、Phase G3 で UI 設定化。

---

## 6. threat intel feed cache service

### 6.1 feed 構成

| feed | URL | 形式 | 更新頻度 |
|---|---|---|---|
| **PhishTank** | https://data.phishtank.com/data/online-valid.json.gz | JSON | 1 時間 |
| **OpenPhish** | https://openphish.com/feed.txt | text (1 line per URL) | 12 時間 |
| **URLhaus** | https://urlhaus.abuse.ch/downloads/csv_online/ | CSV | 5 分 |
| **Spamhaus DBL** | (DNS query) | DNS | per-query (= cache 不可) |
| **SURBL** | (DNS query) | DNS | per-query |
| **Google Safe Browsing** | https://safebrowsing.googleapis.com/v4/threatMatches:find | API | per-query (= opt-in) |

PhishTank / OpenPhish / URLhaus は **完全ローカル照合**、Spamhaus DBL / SURBL は DNS query (= domain だけ外部に出る、本文は出ない)、Google Safe Browsing は **URL を Google に送るので opt-in 必須**。

### 6.2 cache 構造

`threat_intel_url_cache` テーブル (= mail-threat-detection §4.4 で定義済):

```sql
CREATE TABLE threat_intel_url_cache (
  url_hash    BYTEA PRIMARY KEY,   -- SHA-256(normalized URL)
  feed_source TEXT NOT NULL,       -- 'phishtank' | 'openphish' | 'urlhaus'
  threat_type TEXT NOT NULL,       -- 'phishing' | 'malware' | 'scam'
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX idx_threat_intel_url_cache_expires ON threat_intel_url_cache (expires_at);

CREATE TABLE threat_intel_feed_status (
  feed_source     TEXT PRIMARY KEY,
  last_fetched_at TIMESTAMPTZ,
  last_count      INTEGER,
  last_error      TEXT
);
```

URL 正規化規則 (= 同一 URL の重複 hit を防ぐ):
- scheme を https に統一
- hostname を lowercase
- trailing `/` を除去
- fragment (`#...`) を除去
- 同一 path で複数 query string がある場合は query を抽出して sort

### 6.3 daily fetcher

mail-security 内の `services/feed-fetcher.ts`:

```ts
export async function refreshAllFeeds(): Promise<void> {
  const settings = await getFeedSettings();   // どの feed が enabled か
  await Promise.allSettled([
    settings.phishtank.enabled  && fetchPhishTank(),
    settings.openphish.enabled  && fetchOpenPhish(),
    settings.urlhaus.enabled    && fetchUrlhaus(),
  ].filter(Boolean));
}

async function fetchPhishTank(): Promise<void> {
  const res = await fetch("https://data.phishtank.com/data/online-valid.json.gz", {
    headers: { "User-Agent": "yui-agent/mail-security" },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) { ... }
  const buf = Buffer.from(await res.arrayBuffer());
  const json = JSON.parse(gunzipSync(buf).toString());
  // [{phish_id, url, ...}]
  await batchUpsertCache(json.map((e: any) => ({
    url: e.url,
    feedSource: "phishtank",
    threatType: "phishing",
    expiresAt: new Date(Date.now() + 24 * 3600_000),
  })));
}
```

**起動方式 (= interval 前提、cron parser を使わない)**:

Yui の既存 periodic 機構 (`src/periodic/types.ts:19`) は **intervalMs ベース** (= cron 構文非対応)。`src/lib/scheduler.ts:46` も cron parser を持たない。よって以下で実装:

- Yui 側 `src/periodic/threat-intel-refresh.ts` を `schedule: { kind: "interval", everyMs: 24 * 60 * 60_000 }` (= 24h) で登録
- 内部で `state guard` を使い、`last_fetched_at` (= `threat_intel_feed_status` table) が 12h 未満なら skip (= 起動直後の重複呼出防止)
- 実行内容は mail-security の `POST /threat-intel/refresh` を internalFetch で叩くだけ (= mail-security 内に独立 cron を持たない)

`node-cron` 依存は **使わない** (= Yui 既存機構に統一)。

### 6.4 query API

```
POST /threat-intel/query
  body: { urls: string[] }
  response: { hits: Array<{ url, feedSource, threatType }> }
```

実装:
1. 各 URL を正規化 → SHA-256 hash
2. cache テーブルを bulk SELECT (= `IN` clause)
3. Spamhaus DBL / SURBL は **opt-in 設定** で DNS query
4. Google Safe Browsing は **opt-in 設定** で API call

---

## 7. mail-security service の実装スタック

### 7.1 言語選定

**TypeScript** (= Yui 全体と統一)。理由:
- 既存の web container と暗号化 lib / 認証 helper を共有しやすい
- Yui 全体の言語統一で保守性が高い
- ClamAV / DB / HTTP すべて Node ecosystem で揃う (= `clamscan`, `pg`, `undici`)
- 定期実行は Yui 既存 `src/periodic/*` intervalMs ベース機構を使う (= §6.3、`node-cron` 等の追加依存なし)

### 7.2 依存パッケージ

| package | 用途 |
|---|---|
| `express` or `fastify` | HTTP server (= /scan/* endpoint) |
| `clamscan` | ClamAV daemon client |
| `undici` | URL HEAD fetch (= fetch 互換、AbortSignal timeout 強い) |
| `pg` | postgres direct connection (= drizzle なしの軽量 layer) |
| `private-ip` (or `ip`) | SSRF 防止用 IP 判定 |
| ~~`node-cron`~~ | **不要** (= §6.3 参照、Yui 既存 periodic intervalMs ベース機構を使う) |
| `mailparser` | RFC 822 attachments の base64 decode (= optional、本文は web 側で parse) |

### 7.3 Dockerfile

```dockerfile
# mail-security/Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
EXPOSE 8090
CMD ["node", "src/server.js"]
```

### 7.4 docker-compose 統合

```yaml
services:
  mail-security:
    build: ./mail-security
    restart: unless-stopped
    profiles: ["security"]   # = ClamAV と同じ profile、両方一緒に起動 / 停止
    environment:
      - CLAMAV_HOST=clamav
      - CLAMAV_PORT=3310
      - POSTGRES_URL=postgresql://yui:password@postgres:5432/yui
      - VALKEY_URL=redis://valkey:6379
      - INTERNAL_AUTH_TOKEN=${INTERNAL_AUTH_TOKEN}    # § 2.4: AUTH_TOKEN と別 secret
      - MAX_SCAN_SIZE=52428800                        # = 50MB、§3.3 ClamAV と同期
      - GSB_API_KEY=${GSB_API_KEY:-}                  # = Google Safe Browsing、opt-in
    depends_on:
      clamav:
        condition: service_healthy
      postgres:
        condition: service_healthy
    networks: [yui-internal, yui-mail-security]
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://localhost:8090/health"]
      interval: 30s
      start_period: 30s
```

### 7.5 directory レイアウト

```
vroid/
  ├── mail-security/
  │   ├── package.json
  │   ├── Dockerfile
  │   └── src/
  │       ├── server.ts              ← HTTP server entry
  │       ├── services/
  │       │   ├── clamav.ts
  │       │   ├── url-analysis.ts
  │       │   ├── feed-fetcher.ts
  │       │   └── threat-intel.ts
  │       ├── lib/
  │       │   ├── ssrf.ts
  │       │   └── auth.ts             ← X-Internal-Auth 検証
  │       └── routes/
  │           ├── scan.ts
  │           └── threat-intel.ts
```

Yui の monorepo の中に新規 sibling directory として配置。`apps/discord-bot/` と同じパターン。

---

## 8. web container 側の client lib

### 8.1 `src/lib/file-scanner.ts` (新規)

§4.2 に既に書いた。`scanFile(bytes, filename)` を export。

### 8.2 `src/lib/url-scanner.ts` (新規)

```ts
export async function analyzeUrl(url: string): Promise<UrlVerdict> {
  return internalPost("/scan/url", { url });
}
```

### 8.3 `src/lib/threat-intel-client.ts` (新規)

```ts
export async function queryThreatIntel(urls: string[]): Promise<ThreatIntelHit[]> {
  if (urls.length === 0) return [];
  const result = await internalPost<{ hits: ThreatIntelHit[] }>("/threat-intel/query", { urls });
  return result.hits;
}
```

これらは mail-threat-detection.md §2.4 / §2.5 から呼ばれる:
- Layer 4 (URL 解析) → `analyzeUrl`
- Layer 5 (threat intel) → `queryThreatIntel`
- 添付 → `scanFile`

### 8.4 fallback 戦略

mail-security 不在 / 不応答時:
- `scanFile` → `skipped` を返す (= mail-poll は止まらない)
- `analyzeUrl` → `{ error: "scanner unavailable", flags: {} }` を返す
- `queryThreatIntel` → `[]` を返す
- これにより Layer 4/5 が無効化されるだけで、Layer 1/2/3/6 だけで判定継続

---

## 9. API endpoint (= mail-security service 側)

### 9.1 全 endpoint 一覧

```
POST /scan/file                  (= ファイルウィルススキャン)
  multipart: file, filename
  response: ScanVerdict

POST /scan/url                   (= URL HEAD 解析)
  body: { url, options? }
  response: UrlVerdict

POST /threat-intel/query         (= URL 照合)
  body: { urls: string[] }
  response: { hits: ThreatIntelHit[] }

POST /threat-intel/refresh       (= feed 強制 refresh、periodic trigger or 手動)
  body: { feeds?: string[] }     // 省略時は all
  response: { updated: { feed: string, count: number }[] }

GET  /health                     (= healthcheck)
  response: { status: "ok", clamav: "connected"|"unavailable", feeds: {...} }
```

### 9.2 認証

全 endpoint (= /health 以外) は `X-Internal-Auth` ヘッダ必須。env `INTERNAL_AUTH_TOKEN` と一致しない req は 401。

### 9.3 エラーハンドリング

- catch ブロックは raw error をログ出力 + client には固定 status code + 固定メッセージ
- web 側の `clientError()` と同じ思想を mail-security 側でも適用

---

## 10. セキュリティ

### 10.1 ウィルス検体取り扱い

- ClamAV daemon に渡す bytes は **disk に書かない** (= stream で渡す)、ファイルとして永続化しない
- もし sandbox を後付けで実装する場合、untrusted bytes の保存先は専用 volume + 隔離 directory + 自動削除

### 10.2 SSRF 防止

- URL HEAD fetch は `resolvesToPrivateIp` で内部 IP を除外
- redirect chain も全段で同じチェック
- 攻撃者が `https://attacker.com → 302 redirect → http://127.0.0.1/admin` のような誘導をしてきても止まる

### 10.3 mail-security / clamav の outbound 制限

- docker-compose の network 分離で **`yui-internal` には参加させない** (= Yui の他 container = web/postgres/valkey 等にはアクセスできない)。これは Docker レイヤで担保される
- ただし **host LAN / RFC1918 宛 (= 自宅 LAN / Tailnet 等) への outbound** は Docker network 分離だけでは止まらない。完全に止めたい場合は以下を追加:
  - iptables ルール (= Docker daemon-level、`DOCKER-USER` chain で source = mail-security / clamav network、destination = RFC1918 / link-local を REJECT)
  - もしくは Docker network policy (= calico 等の外部 plugin が要る、kube 環境想定)
- threat intel feed のドメイン (= phishtank.com, openphish.com 等) を明示的 allow list 化することも可、ただし運用負担増 (= Phase G6+)
- ClamAV は freshclam 用の HTTPS outbound が必須 (= §2.3.1)、これも上記 iptables ルールでは exception として `database.clamav.net` 系を許可する必要あり

### 10.4 認証 token (= front-door と service-to-service の分離)

- **`AUTH_TOKEN` (front-door) と `INTERNAL_AUTH_TOKEN` (service-to-service) は別 secret** (= §2.4 詳細)
- 両方とも `.env` で管理、長さ 256bit 以上 (= `openssl rand -base64 32`)
- mail-security と web で `INTERNAL_AUTH_TOKEN` を共有、`AUTH_TOKEN` は web のみが知る
- token rotation は将来 (= 全 service 再起動が必要、運用 cost)
- 万一 mail-security 側が侵害されても、`AUTH_TOKEN` を持っていないので web の front-door API には touch できない (= 侵害範囲を物理的に隔離)

### 10.5 ログサニタイズ

- ClamAV から返ってきた virus name は安全 (= 既知 name のみ)
- URL は log に出して問題なし (= public な web URL のみ)
- メール本文 / 添付の bytes 内容は **log に絶対出さない**

---

## 11. 段階的実装

### Phase S1 (= 1 日、ClamAV foundation)

- `mail-security/` directory 作成、Dockerfile + 基本 server (= /health のみ)
- docker-compose に clamav + mail-security 追加
- `services/clamav.ts` 実装、`/scan/file` endpoint
- web 側 `src/lib/file-scanner.ts` 実装
- VRM upload に `scanFile` 統合 (= 既存 magic byte check の後段、PoC として小さく)
- 動作確認: 適当な EICAR test virus ファイルを scanFile に投げて infected が返る

### Phase S2 (= 半日、URL HEAD)

- `services/url-analysis.ts` 実装 + `/scan/url` endpoint
- `lib/ssrf.ts` (= private IP 検出)
- 静的 flag (Punycode / shortener / TLD) 検出
- web 側 `src/lib/url-scanner.ts`
- mail-threat-detection.md の Layer 4 (URL) からの呼び出し配線

### Phase S3 (= 1 日、threat intel feed)

- migration 0071: `threat_intel_url_cache` + `threat_intel_feed_status` テーブル作成
- `services/feed-fetcher.ts` (= PhishTank / OpenPhish / URLhaus)
- `services/threat-intel.ts` (= query API)
- `/threat-intel/refresh` endpoint
- Yui 側 `src/periodic/threat-intel-refresh.ts` で 1 日 1 回 trigger
- mail-threat-detection.md の Layer 5 配線

### Phase S4 (= 半日、追加 feed)

- Spamhaus DBL / SURBL の DNS query 実装
- Google Safe Browsing 統合 (= opt-in 設定 UI)
- WHOIS / RDAP query (= domain registration date)

### Phase S5 (= 将来、添付 sandbox)

- 添付 sandbox 設計 (= Cuckoo / Firejail / 自前 VM、別 doc)
- 画像 ML (= brand logo 検出)
- ML 推論サーバ統合 (= Python service として更に分離する可能性)

---

## 12. テスト観点

### 12.1 機能テスト

- [ ] mail-security コンテナが healthy で起動
- [ ] ClamAV daemon が起動 + virus DB がロード済み
- [ ] EICAR test file を `/scan/file` に投げて `status=infected` + `virusName` が返る
- [ ] 正常ファイル (= テキスト 1KB) を投げて `status=clean`
- [ ] 100MB の clean ファイルが 5 秒以内に scan される
- [ ] ClamAV を停止 → `status=skipped` で fallback、web 側で mail-poll が止まらない
- [ ] `/scan/url https://google.com` で `finalUrl` / `redirectChain` / `flags.shortener=false` 等
- [ ] `/scan/url https://localhost/admin` が SSRF 検出で reject
- [ ] PhishTank feed download 後、`/threat-intel/query` で known phishing URL が hit する
- [ ] `INTERNAL_AUTH_TOKEN` 不一致の req が 401

### 12.2 セキュリティテスト

- [ ] mail-security から内部 IP (= 10.x / 192.168.x / 127.0.0.1) に HTTP できない
- [ ] redirect 経由の SSRF が止まる (= 攻撃 fixture で確認、`/scan/url` に攻撃 URL を投げて検出)
- [ ] **DNS rebinding 攻撃が止まる**: 攻撃 URL `http://attacker.example.com` の DNS が:
  - 1 回目 lookup → 外部 IP (= permit)
  - 2 回目 lookup → 内部 IP (= 攻撃側が DNS TTL=0 で切替)
  という流れで内部に誘導された場合に block されること。対策は **lookup → IP 検証 → 同じ IP に fetch** (= URL の hostname を resolve して内部 IP を含むかチェックした後、その IP で接続する。再度 DNS を引かない) を mail-security の URL HEAD service 内で実装
- [ ] mail-security から外部 HTTPS 経由で別 container (= web/postgres) の port に届かない (= Docker network 分離検証)
- [ ] `INTERNAL_AUTH_TOKEN` 不一致の req が 401 (= /scan/file, /scan/url, /threat-intel/* すべて)
- [ ] **`INTERNAL_AUTH_TOKEN` を持つ攻撃者が `AUTH_TOKEN` を必要とする web の front-door endpoint (= `/api/chat` 等) には touch できない** (= 2 token 分離検証)
- [ ] mail-security の log に bytes content / mail body が出ない
- [ ] mail-security の log に `INTERNAL_AUTH_TOKEN` 値そのものが出ない (= 401 時の err message に embed しない)
- [ ] DB ダンプで `threat_intel_url_cache` に PII / 本文断片が無い
- [ ] LLM (Layer 6) プロンプトインジェクション耐性: 本文に "ignore prior instructions" 入れても judge が壊れない
- [ ] EICAR test file 以外に **zip bomb** / **deeply nested archive** で ClamAV が hang しない (= ClamAV 側設定 `MaxRecursion` / `MaxFileSize` で守る)
- [ ] scanFile の MAX_SCAN_SIZE 超過で **stream を最後まで読まない** (= 早期 abort、メモリ占有しない)

### 12.3 統合テスト

- [ ] フィッシング fixture mail を mail-poll → 添付 scan → infected 検出 → mail_threat 通知
- [ ] URL 含む mail → analyzeUrl → threatIntelHit → Layer 5 reason に "phishtank_hit"
- [ ] VRM upload (= 既存) で scanFile が呼ばれ、infected なら upload reject + cleanup

---

## 13. リスク / 注意

- **ClamAV virus DB の容量**: 約 500MB-1GB、`clamav_data` volume が必要。初回起動で virus DB ダウンロードに 5-10 分かかる
- **freshclam の network 使用**: 4 時間ごとに virus DB 更新 (= ~50-200MB)、帯域使用注意
- **PhishTank の rate limit**: API key 無しでも feed download 可能だが、頻繁すぎると blocked。1 時間に 1 回まで
- **URLhaus の更新頻度**: 5 分間隔だが、こちらは「Yui の polling は 1 日 1 回で十分」(= 即時性求められる用途でない)
- **mail-security コンテナの memory**: ClamAV scan で 200-500MB、feed cache で 100MB 程度。1GB 推奨
- **ARM64 サポート**: ClamAV は ARM64 image あり (= Apple Silicon Docker でも動く)、確認済み

---

## 14. プライバシー

- **ClamAV scan は完全ローカル**: bytes は外部送信されない
- **threat intel feed は download のみ**: URL を外部に送らずローカル照合
- **DNS query (Spamhaus DBL/SURBL)**: domain だけ外部 DNS に出る、本文は出ない、user に明示
- **Google Safe Browsing は opt-in**: URL を Google に送るため、デフォルト OFF、設定で明示有効化

---

## 15. 将来拡張余地

- **添付 sandbox** (Cuckoo / Firejail / 自前 KVM)、別 service として更に分離
- **画像 ML** (= brand logo 検出、Python service)
- **ML 継続学習** (= user feedback → モデル再訓練 pipeline)
- **ファイルボックス機能** (= 別 doc、本書の scanner を消費する)
- **複数 ClamAV daemon の負荷分散** (= 大量 mail 流入想定)
- **virus DB の社内独自 signature 追加** (= 個人 / 組織固有の脅威 pattern)
- **GitOps な feed 設定** (= feed 一覧を git で版数管理)
- **runtime mining 検出** (= 行動 sandbox の高度化)

---

## 16. コミット規約

- mail-security の新規 dependency (= clamscan, undici, private-ip) は理由説明 + lockfile commit
- migration 0071 (= threat_intel_url_cache + status) は idempotent
- Commit message は `Phase S1: mail-security service foundation — ClamAV ...` のように Phase 番号 prefix

---

## 17. 関連ドキュメント

- [`docs/mail-threat-detection.md`](mail-threat-detection.md) — 本書の scanner を消費するメインユーザ
- [`docs/mail-accounts.md`](mail-accounts.md) — メール取り込み層
- [`docs/mail-system.md`](mail-system.md) — メール全体パイプライン
- [`https://github.com/sakuranaga/local-ai-search`](https://github.com/sakuranaga/local-ai-search) — ClamAV パターン由来 (= `backend/app/services/antivirus.py`)
- [`CLAUDE.md`](../CLAUDE.md) — 規約

---

## 18. 監査スクリプト

```bash
# mail-security 不在時 fallback が効くか確認 (= scanFile が skipped を返す)
docker compose stop mail-security
# Yui で適当な VRM upload を試す → 「未スキャン」表示で upload 完了

# ClamAV daemon の生存確認
docker compose exec clamav clamdcheck.sh

# feed cache の age を確認
docker compose exec postgres psql -U yui -c "SELECT feed_source, last_fetched_at FROM threat_intel_feed_status;"

# mail-security の outbound が外部 HTTPS のみに制限されているか確認
docker compose exec mail-security wget -O - http://10.0.0.1 2>&1 | grep -i "refused\|timeout"
```
