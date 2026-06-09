# プロジェクト規約 — Yui Agent

このファイルは Yui Agent (このリポジトリ) で作業する AI / コラボレータ向けの規約集です。

---

## エラーハンドリング: client に生エラーを返さない

**rule**: API ルートの `catch` ブロックで `e.message` / `String(e)` / 上流 API のレスポンス本文を、HTTP response (JSON / redirect query / `errors[]` 配列など) に**そのまま乗せない**。

**理由**: 上流 API レスポンス、DB ドライバ詳細、内部ホスト名、上流 stack 断片などが偵察に使われる。OSS 配布前の Phase D security review で全 API route を sweep して閉じた経路。

### 1. 通常の catch — `clientError()` を使う

ヘルパ: `src/lib/api-error.ts`

```ts
import { clientError } from "@/lib/api-error";

export async function POST(req: NextRequest) {
  try {
    // ...
  } catch (e) {
    return clientError(req, e, {
      status: 500, // 既定 500、省略可
      context: "mail/draft", // server log にタグ付け
      message: "下書きの保存に失敗しました", // client に返す固定文
    });
  }
}
```

- server log には full detail + stack を `[api-error]` タグ付きで出力
- client には `{ error: <安全な固定文> }` を返す

### 2. 既知エラーで分岐したい場合

エラーメッセージを inspect して status code を分けたい時 (= 例: 403 / scope 不足) は、`msg` を**ローカル変数として**使って、レスポンスは `clientError` で返す。

```ts
} catch (e) {
  const msg = e instanceof Error ? e.message : String(e);
  if (msg.includes("403") || msg.includes("insufficientPermissions")) {
    return clientError(req, e, {
      status: 403,
      context: "mail/draft",
      message: "Gmail 権限が不足しています。設定 > 連携 で再連携してください。",
    });
  }
  return clientError(req, e, {
    context: "mail/draft",
    message: "下書きの保存に失敗しました",
  });
}
```

`msg` を `NextResponse.json({ error: msg })` に直接渡すのは NG。

### 3. OAuth callback の redirect query

callback で失敗した時、`?error=<msg>` のように redirect URL に乗せると history / proxy log / ブラウザ拡張に残るので、**固定文に丸める**。詳細は `console.error` で server log に。

```ts
try {
  await completeAuthorization(code);
} catch (e) {
  console.error("[xxx/callback] failed:", e instanceof Error ? e.message : String(e));
  resultError = "callback: authorization failed (see server log)";
}
```

### 4. `errors[]` 配列を返す API (bulk 処理)

`mail/poll` のように複数件処理の結果を `errors[]` で返す API でも同じ。`errors.push(e.message)` は NG。固定文 + console.warn で。

```ts
} catch (e) {
  console.warn("[mail/poll] account sync failed:", acc.email, e);
  errors.push(`${acc.email}: メール取得に失敗しました`);
}
```

### 5. ai-settings/test のような診断 endpoint

ユーザに「なぜ失敗したか」を見せたい endpoint は、`sanitizeTestError()` のような専用関数で「HTTP xxx」「timeout」「DNS resolution failed」など固定カテゴリに分類して返す (`src/app/api/ai-settings/test/[provider]/route.ts` 参照)。生メッセージは絶対 NG。

### 6. tool_result / LLM 内部経路は対象外

`chat/route.ts` の `errString()` のように、catch 結果を Anthropic API の `tool_result` content として LLM に戻すケースは、HTTP response として client に直接届くわけではないので対象外。ただし LLM が user に伝聞で漏らす可能性はあるので、システムプロンプト側で「raw error を user にそのまま伝えない」を指示しておく前提。

### grep でセルフチェック

新規 route 追加時に、以下が hit したら見直す:

```bash
grep -rn -E "(error: e\.message|error: msg|errors\.push.*e\.message|searchParams\.set.*e\.message)" src/app/api --include="*.ts"
```

---

## 関連セキュリティ規約 (Phase D で導入)

- **外向き HTTP fetch**: 必ず `safeFetch` (`src/lib/safe-fetch.ts`) 経由。public な URL は `validatePublicUrl` (`src/lib/url-validate.ts`) で DB 保存前に検証。eslint の `no-restricted-syntax` で生の `fetch()` を警告。公式 API endpoint (Google / Anthropic / Spotify 等の固定 URL) のみ `eslint-disable-next-line` コメントで許可。
- **OAuth refresh/access token**: `src/lib/crypto.ts` の `encryptText`/`decryptText` で AES-256-GCM 暗号化。新規 token は必ず `encrypted_*` 列に書き、plaintext 列は NULL に倒す。`ENCRYPTION_KEY` env が前提。
- **timer/alarm 発火時の保存 prompt**: 生の user message として再投入しない。`source: "timer"` + `timerEvent.savedText` で `/api/chat` に渡し、chat route 側で system guard + tool allowlist を適用 (`src/app/api/chat/route.ts` の `TIMER_ALLOWED_TOOLS` / `buildTimerSystemGuard` 参照)。
- **debug route**: `ENABLE_DEBUG_ROUTES=1` env が無いと 404。`src/app/api/debug/*` で実装パターン参照。
- **ファイル upload**: magic byte 検証 + 失敗時 DB row / ファイル両方 cleanup。`src/app/api/vrm/models/route.ts` 参照。
- **認証**: cookie `vroid-auth` (SameSite=Strict) + 内部呼び出しは `X-Internal-Auth` ヘッダ。OAuth callback 等の cross-site 復路は `src/proxy.ts` の `PUBLIC_PATHS` に追加 (= state cookie 比較で CSRF を防ぐ前提)。Next 16 で `middleware.ts` → `proxy.ts` にリネーム済 (公式 codemod `middleware-to-proxy`)。
