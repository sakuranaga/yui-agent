# メール接続設定 (多 provider 対応) 設計書

## 0. 本書の位置付け

### 0.1 既存設計との関係

- **`docs/mail-system.md`**: メール処理パイプライン全体の設計 (= polling → curate → notification → UI)。本書は **取り込み層 (intake)** に焦点を絞る
- **`docs/mail-classification.md`**: 重要度分類 (= important/needed/unneeded)。本書とは独立
- **`docs/mail-threat-detection.md`**: 脅威検出。本書の intake adapter 構造 (= §3) を参照

### 0.2 設計の背景

現状の Yui は **Gmail OAuth に固定された取り込み構造** (= `src/lib/mail-poll.ts` / `gmail_accounts` table)。OSS として配布する以上、これは制約になる:

- Gmail アカウントを持たない user (= 自前メールサーバ運用者 / 企業 Exchange / 大学メール etc.)
- Gmail の API 制限を避けたい user
- プライバシー重視で Google にデータを置きたくない user
- 複数 provider のメールを 1 つの Yui で集約したい user

本書では **Gmail / IMAPS / POP3S を統一的に扱う intake adapter 層** を設計する。同時に、複数アカウント (= 同じ adapter で複数 / 異なる adapter 混合) を user UI から追加 / 編集 / テスト できる仕組みを定義する。

### 0.3 想定 user

- 個人 1 ユーザ運用 (= 既存 Yui の前提を維持)、複数アカウントは「ご主人様 1 人が複数のメールサービスを使い分け」を想定
- 例: 個人 Gmail + 会社 IMAP + 大学 webmail (POP3) を全部 Yui で集約

---

## 1. 要件

### 1.1 機能要件

- ユーザは設定画面で:
  - Gmail (= OAuth フロー、既存) を追加 / 編集 / 削除
  - IMAPS アカウント (= host / port / username / password) を追加 / 編集 / 削除
  - POP3S アカウント (= 同上) を追加 / 編集 / 削除
  - **接続テスト** ボタンで認証 + フォルダ取得を試行できる
  - per-account: 取得頻度 / 初回同期日数 / 取得対象フォルダ (= IMAP のみ) / 隔離フォルダ
- 全 adapter のメールが同一 `mail_messages` テーブルに統一スキーマで insert される
- ID/PW は AES-256-GCM で暗号化保存 (= 既存 OAuth token と同方針)
- 接続失敗は per-account でログ + UI に表示、他 account の polling は止まらない

### 1.2 非機能要件

- ID/PW を **絶対に平文で DB / log / SSE / Discord に残さない**
- IMAPS / POP3S は **TLS 必須** (= 平文 IMAP/POP3 は許可しない、設定 UI でも選択肢から除外)
- 接続情報 (host / port / username) は機微情報扱い、UI は閲覧専用 (= マスク不要だが log には出さない)
- adapter 別の取得処理は失敗しても他に影響しない (= Promise.allSettled パターン維持)

### 1.3 スコープ外

- Exchange / EWS / Office 365 専用 API (= IMAPS で代替可能、ただし機能制限あり)
- マルチユーザ (= 1 Yui = 1 ご主人様前提を維持)
- SMTP 経由のメール送信 (= 既存 Gmail compose で対応、IMAPS/POP3S 送信は本書スコープ外、将来 §17)
- カレンダー / 連絡先連動 (= Gmail 以外の provider では人別取り扱い、本書スコープ外)

---

## 2. 既存実装の現状把握 (= fact)

### 2.1 既存 schema

`gmail_accounts` (= `src/db/schema.ts` 既存):

```ts
export const gmailAccounts = pgTable("gmail_accounts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  email: text("email").notNull().unique(),
  // OAuth token (= 暗号化、src/lib/crypto.ts)
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  scopes: jsonb("scopes").$type<string[]>(),
  // 同期状態
  enabled: boolean("enabled").notNull().default(true),
  initialSyncDays: integer("initial_sync_days").notNull().default(3),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  // ...
});
```

これを intake-adapter 一般化した `mail_accounts` に rename + adapter columns を追加する。

### 2.2 既存 mail-poll.ts

`src/periodic/mail-poll.ts` は Gmail-only で:
- `listGmailAccounts({ enabledOnly: true })` で account 取得
- `callGmail()` Helper で `https://gmail.googleapis.com/gmail/v1` を直叩き
- `INBOX` / `SENT` を fetch

これを **adapter pattern に書き換える** (= adapter registry が adapter ごとの実装を呼ぶ)。

---

## 3. アーキテクチャ

### 3.1 Intake Adapter Pattern

```
[mail-poll-orchestrator (= 周期 periodic)]
   │
   │ for each enabled account
   ▼
[getIntakeAdapter(account.adapter)]
   │
   ├─→ GmailAdapter   (= 既存 Gmail OAuth ロジックを移管)
   ├─→ ImapsAdapter   (= 新規、imap-flow npm)
   └─→ Pop3sAdapter   (= 新規、node-pop3 npm)
   │
   │ poll() returns { inserted, fetched, blocked }
   │ insert into mail_messages (unified schema)
   ▼
[curate]  →  [threat-audit]  →  [notify]  (= 既存パイプライン、adapter 非依存)
```

### 3.2 共通 interface

```ts
// src/lib/mail-intake/types.ts
export type MailAdapter = "gmail" | "imaps" | "pop3s";

export type MailAccount = {
  id: number;
  adapter: MailAdapter;
  email: string;
  displayName: string | null;
  enabled: boolean;
  initialSyncDays: number;
  lastSyncedAt: Date | null;
  // adapter-specific (= JSON 列で持つ、§4 参照)
  config: Record<string, unknown>;
};

/**
 * adapter.poll() の返り値契約。
 * orchestrator (= mail-poll-orchestrator) が curate / threat-audit / body fetch を
 * insertedIds に対して回すため、book-keeping を adapter に閉じず明示的に返す。
 */
export type PollResult = {
  /** 今 poll で DB insert された mail_messages の id 配列。
   *  curate / threat-audit / body preemptive fetch / dispatchNotification の入力になる。
   *  ON CONFLICT DO NOTHING で skip された行は **含まない**。 */
  insertedIds: number[];
  /** Gmail/IMAP から取得したメッセージ件数 (= insert 試行前の総数) */
  fetched: number;
  /** ON CONFLICT or blocked 等で skip された件数 (= insertedIds.length と fetched の差) */
  skipped: number;
  /** blocked_addresses (= mail_curation_settings) で reject された件数 */
  blocked: number;
  /** poll 中に発生した non-fatal error (= 1 メッセージ取得失敗等)。adapter 自体が
   *  throw した場合は呼び出し側で catch、ここは部分失敗の蓄積。 */
  errors: string[];
};

export interface IntakeAdapter {
  /** adapter 識別子 */
  readonly name: MailAdapter;

  /** 新着 metadata を pull して mail_messages に insert */
  poll(account: MailAccount): Promise<PollResult>;

  /** 本文を後で fetch する (= curate / threat audit から呼ぶ) */
  fetchBody(
    account: MailAccount,
    externalMessageId: string
  ): Promise<{ text: string; html: string | null; attachments: AttachmentMeta[] }>;

  /** 接続テスト (= UI から呼ぶ、認証 + フォルダ列挙) */
  testConnection(account: MailAccount): Promise<{
    ok: boolean;
    folders?: string[];   // IMAP のみ
    error?: string;
  }>;

  /** ラベル付け / フォルダ移動 (= 隔離アクション、optional) */
  setLabel?(account: MailAccount, externalMessageId: string, label: string): Promise<void>;
  moveToFolder?(account: MailAccount, externalMessageId: string, folder: string): Promise<void>;
  delete?(account: MailAccount, externalMessageId: string): Promise<void>;
}
```

### 3.3 adapter registry

```ts
// src/lib/mail-intake/index.ts
import { gmailAdapter } from "./gmail";
import { imapsAdapter } from "./imaps";
import { pop3sAdapter } from "./pop3s";
import type { IntakeAdapter, MailAdapter } from "./types";

const ADAPTERS: Record<MailAdapter, IntakeAdapter> = {
  gmail: gmailAdapter,
  imaps: imapsAdapter,
  pop3s: pop3sAdapter,
};

export function getIntakeAdapter(name: MailAdapter): IntakeAdapter {
  const a = ADAPTERS[name];
  if (!a) throw new Error(`unknown intake adapter: ${name}`);
  return a;
}
```

### 3.4 mail-poll-orchestrator (= 新 periodic)

`src/periodic/mail-poll.ts` (= 既存) を `mail-poll-orchestrator.ts` に rename し、adapter 経由で全 account を回す:

```ts
const orchestrator: PeriodicModule = {
  id: "mail-poll-orchestrator",
  enabled: true,
  schedule: { kind: "interval", everyMs: 10 * 60_000 },
  run: async (ctx) => {
    const accounts = await listMailAccounts({ enabledOnly: true });
    const allInsertedIds: number[] = [];

    await Promise.allSettled(
      accounts.map(async (acc) => {
        const adapter = getIntakeAdapter(acc.adapter);
        const result = await adapter.poll(acc);
        // allInsertedIds は adapter 内で book-keeping
      })
    );

    // 共通パイプライン (= adapter 非依存)
    if (allInsertedIds.length > 0) {
      await curateMails(allInsertedIds);
      await auditMails(allInsertedIds);
      await dispatchMailNotifications(ctx.sessionId, allInsertedIds);
    }
  },
};
```

---

## 4. データモデル

> **migration 番号と適用順**: runner (`src/db/migrate.ts`) はファイル名順に流すため、実装時は `0069_mail_messages_intake_adapter.sql` (= §4.1) → `0070_gmail_accounts_rename_and_soft_delete.sql` (= §4.2) の順に適用される。本書も実装順で記述する。

### 4.1 migration 0069: mail_messages の intake_adapter 列追加

```sql
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS intake_adapter       TEXT;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS external_message_id  TEXT;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS external_thread_id   TEXT;

-- 旧 gmail_* 列からマイグレート
UPDATE mail_messages SET
  intake_adapter       = 'gmail',
  external_message_id  = gmail_message_id,
  external_thread_id   = gmail_thread_id
WHERE intake_adapter IS NULL;

ALTER TABLE mail_messages ALTER COLUMN intake_adapter SET NOT NULL;
ALTER TABLE mail_messages ALTER COLUMN external_message_id SET NOT NULL;

-- 新 unique constraint (= 既存の (gmail_message_id, account_id) を置換)
-- 注: 既存制約を drop する前に、新制約が full coverage していることを確認
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mail_msg_adapter_ext
  ON mail_messages (intake_adapter, account_id, external_message_id);

-- 旧 gmail_* 列は当面残す (= rollback 保険、Phase Z で drop)
```

### 4.2 migration 0070: gmail_accounts → mail_accounts (+ soft delete)

`src/db/migrate.ts` の runner はファイル単位 transaction だが、`ALTER TABLE ... RENAME` 自体は idempotent でないため、再実行時に「存在しない」で fail する。`to_regclass()` で存在チェックを挟む:

```sql
-- Step 1: rename テーブル (= 既に rename 済なら no-op)
DO $$
BEGIN
  IF to_regclass('public.gmail_accounts') IS NOT NULL
     AND to_regclass('public.mail_accounts') IS NULL THEN
    EXECUTE 'ALTER TABLE gmail_accounts RENAME TO mail_accounts';
  END IF;
END $$;

-- Step 2: adapter 列追加 + adapter-specific 列追加
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS adapter TEXT NOT NULL DEFAULT 'gmail';

-- IMAPS/POP3S 用列 (= NULL 許容、Gmail 行では未使用)
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_host          TEXT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_port          INTEGER;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_username      TEXT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS imap_folders       JSONB;
                                                              -- 監視対象フォルダ list、例 ["INBOX", "個人/重要"]
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS pop3_host          TEXT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS pop3_port          INTEGER;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS pop3_username      TEXT;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS pop3_delete_on_fetch BOOLEAN DEFAULT FALSE;

-- 共通: 暗号化 password (IMAPS/POP3S 用)
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS encrypted_password TEXT;

-- 共通: 隔離フォルダ名 (= IMAPS のみ意味あり、Gmail はラベル使用)
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS quarantine_folder  TEXT DEFAULT 'Quarantine';

-- 接続テスト結果のキャッシュ (= UI ダッシュボード用)
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS last_connect_ok    BOOLEAN;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS last_connect_at    TIMESTAMPTZ;
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS last_connect_error TEXT;

-- adapter 列を NOT NULL 化 (= 全行が 'gmail' で埋まった後)
-- 上の DEFAULT 'gmail' で既存行は自動補完される

-- account 削除は soft delete に統一 (= §9.4 / §10 削除設計)。
-- 理由: 物理 DELETE + ON DELETE SET NULL 案だと、mail_messages.account_id = NULL に
-- なった行が増え、新 unique index (intake_adapter, account_id, external_message_id) で
-- NULL 同士は重複扱いされない (= Postgres unique index 仕様)。すると同じ user が同じ
-- account を再登録 + 過去メールを再取得した時、external_message_id が同じでも account_id
-- が NULL vs 新 id で別行として insert されてしまう (= 重複)。
-- soft delete (deleted_at) なら mail_messages.account_id は変わらず、unique key も
-- intact のまま、過去メール参照も活きる、再登録は新 id で別 account として共存。
ALTER TABLE mail_accounts ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_mail_accounts_active
  ON mail_accounts (id)
  WHERE deleted_at IS NULL;

-- 既存 email UNIQUE (= 0037_mail_schema.sql で定義) を drop して active 行のみの
-- partial unique に置き換える。これがないと、soft delete した account と同じ email を
-- 再登録できない (= 「再登録は新 id で別 account として共存」前提が破綻する)。
-- 既存 unique constraint 名を pg_constraint から動的取得して drop。
DO $$
DECLARE
  email_unique_name TEXT;
BEGIN
  SELECT con.conname INTO email_unique_name
  FROM pg_constraint con
  JOIN pg_class cl ON cl.oid = con.conrelid
  WHERE cl.relname = 'mail_accounts'
    AND con.contype = 'u'
    AND 'email' = ANY(SELECT attname FROM pg_attribute
                       WHERE attrelid = cl.oid AND attnum = ANY(con.conkey));
  IF email_unique_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE mail_accounts DROP CONSTRAINT %I', email_unique_name);
  END IF;
END $$;

-- active な行だけが (adapter, lower(email)) で一意 (= soft delete 済とは衝突しない)。
-- lower() は同一 email を大小文字差で重複登録できないようにするため。
CREATE UNIQUE INDEX IF NOT EXISTS uniq_mail_accounts_active_adapter_email
  ON mail_accounts (adapter, lower(email))
  WHERE deleted_at IS NULL;

-- 既存 FK (= ON DELETE CASCADE) は維持。物理 DELETE は禁止する運用に切り替え、
-- 全 API / orchestrator が WHERE deleted_at IS NULL でフィルタする。
-- 「過去メールも完全削除したい」場合は `/api/mail/accounts/<id>/purge` (= §17 将来)
-- で mail_messages の物理削除 → mail_accounts の物理 DELETE の順に行う。
```

**注**: 旧設計案 (= ON DELETE SET NULL + account_id nullable) は重複問題により撤回。本書は soft delete を正本とする。

### 4.3 schema.ts 反映

```ts
export const mailAccounts = pgTable("mail_accounts", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  adapter: text("adapter").notNull().$type<"gmail" | "imaps" | "pop3s">(),
  // email は soft delete 対応のため column-level の .unique() を外し、
  // active 行のみの partial unique index で一意性を担保する (= migration §4.2 参照)。
  email: text("email").notNull(),
  displayName: text("display_name"),
  enabled: boolean("enabled").notNull().default(true),
  initialSyncDays: integer("initial_sync_days").notNull().default(3),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),

  // Gmail OAuth (= 既存)
  encryptedAccessToken: text("encrypted_access_token"),
  encryptedRefreshToken: text("encrypted_refresh_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", { withTimezone: true }),
  scopes: jsonb("scopes").$type<string[]>(),

  // IMAPS
  imapHost: text("imap_host"),
  imapPort: integer("imap_port"),
  imapUsername: text("imap_username"),
  imapFolders: jsonb("imap_folders").$type<string[]>(),

  // POP3S
  pop3Host: text("pop3_host"),
  pop3Port: integer("pop3_port"),
  pop3Username: text("pop3_username"),
  pop3DeleteOnFetch: boolean("pop3_delete_on_fetch").default(false),

  // 共通
  encryptedPassword: text("encrypted_password"),  // IMAPS/POP3S 用
  quarantineFolder: text("quarantine_folder").default("Quarantine"),
  lastConnectOk: boolean("last_connect_ok"),
  lastConnectAt: timestamp("last_connect_at", { withTimezone: true }),
  lastConnectError: text("last_connect_error"),

  // soft delete (= 物理 DELETE 禁止、§4.2 参照)
  deletedAt: timestamp("deleted_at", { withTimezone: true }),

  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  // active 行のみ (adapter, lower(email)) で一意。
  // partial unique index は Drizzle の table builder で uniqueIndex().where() で表現:
  activeAdapterEmailUq: uniqueIndex("uniq_mail_accounts_active_adapter_email")
    .on(t.adapter, sql`lower(${t.email})`)
    .where(sql`${t.deletedAt} IS NULL`),
}));
```

---

## 5. adapter 実装

### 5.1 Gmail Adapter

既存 `mail-poll.ts` のロジックを `src/lib/mail-intake/gmail.ts` に移管。OAuth token / scope / Gmail API 呼び出しはそのまま。`fetchBody` / `setLabel` / `delete` を IntakeAdapter interface に合わせて wrap。

主な作業:
- `gmail_accounts` 参照を `mail_accounts WHERE adapter = 'gmail'` に置換
- `gmail_message_id` / `gmail_thread_id` への参照を `external_message_id` / `external_thread_id` に置換

### 5.2 IMAPS Adapter

新規 `src/lib/mail-intake/imaps.ts`。npm package 検討:

| package | maintained | TLS | OAuth XOAUTH2 | 注釈 |
|---|---|---|---|---|
| **imapflow** | ✅ active | ✅ | ✅ | 推奨、Nodemailer 系列で品質高い |
| node-imap | 古い | ✅ | △ | 設計古め、コミュニティ fork が複数 |
| emailjs-imap-client | △ | ✅ | ✅ | browser 兼用 |

**推奨**: `imapflow` を採用。

```ts
import { ImapFlow } from "imapflow";
import { decryptText } from "@/lib/crypto";

async function poll(account: MailAccount): Promise<PollResult> {
  const password = await decryptText(account.config.encryptedPassword as string);
  const client = new ImapFlow({
    host: account.config.imap_host as string,
    port: account.config.imap_port as number,
    secure: true,                       // TLS 必須
    auth: { user: account.config.imap_username as string, pass: password },
    logger: false,                       // 機密情報を log に流さない
  });

  await client.connect();
  try {
    const folders = (account.config.imap_folders as string[]) ?? ["INBOX"];
    let fetched = 0, inserted = 0;

    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder);
      try {
        // 直近 N 日のメッセージを fetch
        const since = account.lastSyncedAt ?? new Date(Date.now() - account.initialSyncDays * 86400_000);
        const messages = client.fetch(
          { since },
          { envelope: true, source: false, internalDate: true, flags: true }
        );
        for await (const m of messages) {
          fetched++;
          // mail_messages に insert (= 共通スキーマ)
          await insertMailRow({
            adapter: "imaps",
            accountId: account.id,
            externalMessageId: m.envelope.messageId ?? `imap-uid-${m.uid}`,
            externalThreadId: extractThreadId(m.envelope),
            // ...
          });
          inserted++;
        }
      } finally {
        lock.release();
      }
    }
    return { fetched, inserted, blocked: 0, errors: [] };
  } finally {
    await client.logout();
  }
}
```

注意事項:
- **TLS 必須**: `secure: true` を強制、平文 IMAP 拒否
- **logger: false**: 認証情報が log に流れないように
- **AbortSignal**: 全 IMAP 操作にタイムアウト (= 60 秒)
- **大量 mailbox 対策**: 1 回の poll で 100 件まで (= MAX_MESSAGES_PER_POLL を Gmail と同じ運用)

### 5.3 POP3S Adapter

新規 `src/lib/mail-intake/pop3s.ts`。npm package:

| package | maintained | TLS | 注釈 |
|---|---|---|---|
| **node-pop3** | ✅ active | ✅ | 推奨 |
| poplib | 古い | △ | 触らない方が良い |

**推奨**: `node-pop3`。

POP3 の特性:
- folder 概念なし (= INBOX 相当のみ)
- メッセージ削除すると次回 poll で取れない (= 「delete on fetch」設定で挙動制御)
- UID は変動する場合あり → message-id ヘッダで一意性確保
- 隔離 (= フォルダ移動) は **不可能**、ユーザに「POP3 は隔離アクション無効」と UI で明示

```ts
import Pop3Command from "node-pop3";

async function poll(account: MailAccount): Promise<PollResult> {
  const password = await decryptText(account.config.encryptedPassword as string);
  const pop = new Pop3Command({
    user: account.config.pop3_username as string,
    password,
    host: account.config.pop3_host as string,
    port: account.config.pop3_port as number,
    tls: true,                          // TLS 必須
  });

  await pop.connect();
  try {
    const list = await pop.LIST();      // [[id, size], ...]
    let fetched = 0, inserted = 0;
    for (const [msgId] of list) {
      const raw = await pop.RETR(msgId);
      const parsed = await parseRfc822(raw);
      // Message-ID で重複排除
      await insertMailRow({
        adapter: "pop3s",
        accountId: account.id,
        externalMessageId: parsed.messageId ?? `pop3-${msgId}-${Date.now()}`,
        // ...
      });
      fetched++;
      inserted++;
      if (account.config.pop3_delete_on_fetch) await pop.DELE(msgId);
    }
    await pop.QUIT();
    return { fetched, inserted, blocked: 0, errors: [] };
  } catch (e) {
    await pop.QUIT().catch(() => {});
    throw e;
  }
}
```

`parseRfc822` は `mailparser` npm package を使う (= RFC 5322 完全パーサ、Gmail も非 Gmail も統一)。

---

## 6. 接続テスト

各 adapter の `testConnection(account)` を実装、UI から呼び出して接続情報の妥当性を即時確認できる:

- **Gmail**: OAuth token を refresh + `/profile` 呼び出しで email 取得
- **IMAPS**: 接続 + LOGIN + LIST (= フォルダ列挙して UI に表示)
- **POP3S**: 接続 + USER/PASS + STAT (= メッセージ数取得)

返り値:
```ts
{
  ok: boolean;
  folders?: string[];      // IMAP のみ、UI でフォルダ選択に使う
  email?: string;          // OAuth 認証後の confirmed アドレス
  messageCount?: number;   // POP3 STAT 結果
  error?: string;          // 失敗時の固定メッセージ (= raw error は server log のみ)
}
```

エラーハンドリングは `CLAUDE.md` §エラーハンドリング に従い、`clientError` でクライアントに固定文を返す (= 詳細は server log)。

---

## 7. UI 配置

### 7.1 SettingsModal「メール」タブにサブタブ「接続設定」追加

```
┌─ メール ────────────────────────────────────────────────┐
│ [仕分け学習例] [脅威検出] [接続設定]   ← サブタブ          │
├─────────────────────────────────────────────────────────┤
│ 接続設定                                                  │
│                                                          │
│ ─── 登録済アカウント ───                                  │
│ ◉ alice@gmail.com         Gmail   [編集] [削除]  ●      │
│ ◉ alice@example.com       IMAPS   [編集] [削除]  ●      │
│ ◉ alice@univ.ac.jp        POP3S   [編集] [削除]  ○ ← 接続 NG │
│                                                          │
│ [+ アカウント追加 ▼]                                      │
│   ├ Gmail (OAuth)                                        │
│   ├ IMAPS                                                │
│   └ POP3S                                                │
└─────────────────────────────────────────────────────────┘
```

### 7.2 IMAPS / POP3S 追加 / 編集ダイアログ

```
┌─ IMAPS アカウントを追加 ─────────────────────────────────┐
│                                                          │
│ メールアドレス       [alice@example.com    ]            │
│ 表示名 (任意)        [自分の会社メール       ]            │
│                                                          │
│ ─── 接続情報 ───                                          │
│ サーバ              [imap.example.com       ]            │
│ ポート              [993                    ]            │
│ ユーザ名            [alice@example.com     ]            │
│ パスワード          [••••••••••             ]            │
│                                                          │
│ ─── オプション ───                                        │
│ 取得対象フォルダ    [接続テスト後にここに表示 ▾]          │
│ 初回同期日数        [3 日                  ▾]            │
│ ☑ アカウント有効                                          │
│                                                          │
│              [接続テスト]  [保存]  [キャンセル]            │
└─────────────────────────────────────────────────────────┘
```

「接続テスト」を押すと:
1. 仮の MailAccount オブジェクトで `testConnection` を呼ぶ
2. 成功時: フォルダ list を select に展開、保存ボタン enable
3. 失敗時: 固定エラー文を表示 (= 「接続に失敗しました。設定を確認してください」)

### 7.3 POP3S 追加ダイアログ (= IMAPS と類似)

POP3S 固有の項目:
- `☐ 取得後にサーバから削除する` (= delete_on_fetch、デフォルト OFF を強く推奨)
- フォルダ選択なし (= POP3 は INBOX 相当のみ)
- 警告: 「POP3 は隔離 (= dangerous メールのフォルダ移動) ができません。脅威検出時は通知のみで、削除すべきかご主人様が判断する必要があります」

---

## 8. API

```
GET    /api/mail/accounts
  全 account の list (= password は returned しない、UI で *** マスクで表示)

POST   /api/mail/accounts
  body: { adapter, email, displayName?, config: { ... }, password? }
  新規追加。Gmail は OAuth flow を返す redirect URL

PATCH  /api/mail/accounts/<id>
  body: 部分更新可、password 省略時は既存値維持 (= マスク表示用)

DELETE /api/mail/accounts/<id>
  account 削除 + 関連 mail_messages の参照を保持 (= 過去メールは残す)

POST   /api/mail/accounts/<id>/test
  接続テスト、結果を返す + last_connect_* に保存

POST   /api/mail/accounts/<id>/oauth-start
  Gmail のみ: OAuth flow 開始 (= 既存 /api/gmail/oauth/start の汎用化)
```

エラーハンドリング: 全 endpoint で `clientError()` 使用、context は `"mail-accounts"`、固定メッセージ。

---

## 9. セキュリティ

### 9.1 ID/PW の保存

- IMAPS/POP3S の password は **AES-256-GCM 暗号化** で `encrypted_password` 列に保存
- 暗号化は `src/lib/crypto.ts` の `encryptText` / `decryptText` を使用 (= 既存 OAuth token と同じ)
- 復号は **adapter 内のみ**、API response / log / SSE には絶対に出さない

### 9.2 接続情報のマスク

- GET `/api/mail/accounts` で `password` フィールドは `null` 返却 (= 存在を示さない)
- UI 編集時、パスワード入力欄は空表示 + placeholder "(変更しない場合は空のまま)"
- PATCH で password 省略 → 既存維持

### 9.3 TLS 強制

- IMAPS/POP3S はポート 143/110 (= 平文) を **設定 UI で選択不可**
- adapter 内部でも `secure: true` を強制、平文接続が試行されない
- 自己署名証明書は **rejectUnauthorized: true** で拒否 (= デフォルト)
- (将来 §17) self-signed cert を許容する設定オプション (= 個人 LAN サーバ等)

### 9.4 ログサニタイズ

- `imapflow` の `logger: false` (= デフォルト ON で機密情報が console に流れるので OFF)
- error message に password / token を embed しない (= adapter で raw error catch + sanitize)
- console.warn には `accountId` のみ、email アドレスも mask 候補

---

## 10. プライバシー

- すべての受信メールはローカル DB (= pgvector + postgres) に保存、外部送信なし
- adapter 別の本文取得もローカル経由 (= Yui の lib 内で完結)
- 接続情報 (host / username / 取得頻度) はユーザのみが見られる
- **account 削除設計 (= soft delete)**: migration 0070 で `mail_accounts.deleted_at` 列を追加 (= §4.1 SQL)。DELETE API は物理削除でなく `UPDATE mail_accounts SET deleted_at = now()` を実行。全 listing / orchestrator / poll は `WHERE deleted_at IS NULL` でフィルタ。
  - 過去メール (`mail_messages.account_id`) は影響を受けず、参照関係そのまま
  - 同じ user が同じ email を **再登録** しても、新規 id で別 account として共存 (= unique key 衝突なし)
  - UI 側は「削除済 account の過去メール」を `mail_accounts.deleted_at IS NOT NULL` の join で識別、表示モード分岐可
- ご主人様の意思で「過去メールも完全削除したい」場合は別 endpoint (= `/api/mail/accounts/<id>/purge`、§17 将来) で mail_messages → mail_accounts の順に物理削除

---

## 11. 段階的実装

### Phase H1 (= **半日では収まらないため H1a/b/c に分割**)

既存 Gmail 結合は `mail-poll.ts` だけでなく以下に広がっているため、一気にやるとリスク高:
- 周期 poll: `src/periodic/mail-poll.ts`
- 手動 poll API: `src/app/api/mail/poll/route.ts`
- 本文取得: `src/lib/mail-body.ts`
- 添付取得: `src/app/api/mail/[id]/attachment/[attachmentId]/route.ts`
- account CRUD: `src/app/api/mail/accounts/*/route.ts` (= `gmailMessageId` / Gmail API 前提)

3 段階に分けて進める (= 各 step で type-check + 動作確認):

#### Phase H1a: schema 互換 + IntakeAdapter interface 定義 (= 半日)

migration の **runner はファイル名順で流すため、適用順は 0069 → 0070** (= ファイル名順):

- migration 0069 (= mail_messages の intake_adapter / external_message_id / external_thread_id 列追加 + 旧 gmail_* から UPDATE + 新 unique index)
- migration 0070 (= **rename gmail_accounts → mail_accounts + adapter 列 + IMAPS/POP3S 列 + encrypted_password + quarantine_folder + deleted_at + active partial unique index** for `(adapter, lower(email)) WHERE deleted_at IS NULL`) を `to_regclass()` guard + 既存 email UNIQUE drop 動的取得 付きで適用
- schema.ts 反映 (= 旧 gmail_* 列は残す、参照 import を新 mailAccounts に置換、email は `.unique()` を外して `uniqueIndex().where(deletedAt IS NULL)` で定義)
- `src/lib/mail-intake/types.ts` 新規 (= IntakeAdapter interface + PollResult 契約定義)
- 既存 `mail-poll.ts` / `mail-body.ts` / 各 API route は **gmail-specific のまま動作** (= 内部 import 名だけ置換)
- 削除 API は **物理 DELETE → UPDATE deleted_at に変更**、全 listing は `WHERE deleted_at IS NULL` フィルタを追加

**完了条件**: 既存 Yui 動作が無変更で継続、CRUD / poll / 本文 / 添付すべて旧通り、account 削除 → 再登録が同一 email でも DB 制約で fail しない

#### Phase H1b: GmailAdapter 抽出 + orchestrator 切替 (= 半日)

- `src/lib/mail-intake/gmail.ts` 新規 (= 既存 `mail-poll.ts` の poll ロジックを IntakeAdapter 実装として括り出す)
- `src/lib/mail-intake/index.ts` 新規 (= adapter registry stub、gmail のみ)
- `src/periodic/mail-poll.ts` を `mail-poll-orchestrator.ts` に rename、内部で `getIntakeAdapter("gmail").poll(account)` を呼ぶ形に置換
- `PollResult.insertedIds` を返す形で orchestrator は curate / threat-audit / dispatch に渡す
- 手動 poll API (`/api/mail/poll`) も同じ orchestrator 経路に統合

**完了条件**: 周期 poll / 手動 poll の挙動が adapter 経由でも完全に旧通り (= リファクタの透明性)

#### Phase H1c: body / attachment / API / UI の adapter 化 (= 半日)

- `src/lib/mail-body.ts` を `GmailAdapter.fetchBody()` 呼び出しに移管
- `src/app/api/mail/[id]/attachment/[attachmentId]/route.ts` を adapter 経由に書き換え (= `gmail_message_id` 直接参照を `external_message_id` + `intake_adapter` 経由で解決)
- `src/app/api/mail/accounts/*/route.ts` の API を新 mail_accounts スキーマに対応
- UI 側 (= MailModal 等) の `gmail_*` 参照を `external_*` に書き換え (= 影響範囲: mail row 表示、attachment download link)

**完了条件**: 全 Gmail 操作経路が IntakeAdapter 抽象経由になる、`gmail_message_id` の直接参照が GmailAdapter 内部以外に存在しない

### Phase H2 (= 1 日)

- `src/lib/mail-intake/imaps.ts` 新規 (= imapflow)
- 接続テスト endpoint `/api/mail/accounts/<id>/test` + 共通 helper
- SettingsModal「メール > 接続設定」サブタブ、IMAPS 追加 UI
- IMAPS で `imap.gmail.com:993` をテストして Gmail 自体を IMAPS adapter で取得できる ことを確認 (= 動作検証)

### Phase H3 (= 半日)

- `src/lib/mail-intake/pop3s.ts` 新規 (= node-pop3 + mailparser)
- POP3S 追加 UI
- 「delete on fetch」警告 + 隔離不可の UI 注記

### Phase H4 (= 半日)

- 既存 Gmail OAuth flow を `/api/mail/accounts/<id>/oauth-start` に汎用化
- `/api/mail/accounts` CRUD endpoint 完成
- account 削除時の参照 mail_messages の扱い (= 残す、UI で「削除済 account の過去メール」表示モード)
- バックフィル: 接続情報を保存 + 取得テスト UI を polish

### Phase H5 (= 将来、Phase Z 統合)

- 旧 `gmail_*` 列の drop migration
- mail-threat-detection.md の Phase G5 と統合 (= 隔離フォルダ機能、adapter-aware quarantine)

---

## 12. テスト観点

### 12.1 機能テスト

- [ ] migration 0070 適用後、既存 Gmail 行が `adapter='gmail'` で取得可能
- [ ] migration 0069 適用後、既存 mail_messages の `intake_adapter='gmail'` 等が埋まる
- [ ] adapter registry が gmail / imaps / pop3s を解決
- [ ] Gmail account 経由のメール取得が H1 前と同じ件数で動作
- [ ] IMAPS account 追加 → 接続テスト pass → poll で取得
- [ ] POP3S account 追加 → 接続テスト pass → poll で取得
- [ ] 接続失敗 account があっても他 account の poll が止まらない
- [ ] password を平文で log に出さない (= grep で `password|encryptedPassword` 出力監査)
- [ ] DELETE account → mail_accounts から消え、mail_messages は残る

### 12.2 セキュリティテスト

- [ ] 平文 IMAP (= port 143) を adapter に渡しても adapter が拒否する
- [ ] 自己署名証明書 IMAPS に対して `rejectUnauthorized: true` で接続拒否
- [ ] API GET レスポンスに `encrypted_password` / `password` が含まれない
- [ ] DB ダンプを取って `encrypted_password` 列に AES-256-GCM 暗号文 (= base64 形式) があり、平文文字列がない
- [ ] LLM への入力 / 出力に接続情報 (host / username / password) が embed されない

### 12.3 統合テスト

- [ ] Gmail + IMAPS + POP3S を 3 account 登録 → 1 回の orchestrator tick で全部から fetch
- [ ] 同じ メール (= message-id が一致) が複数 account に届いた場合、両方 insert される (= adapter / account でユニーク)
- [ ] account 編集 → password 変更 → 接続テスト OK
- [ ] account 無効化 (= enabled=false) → orchestrator で skip

---

## 13. 後方互換性

| 変更 | 旧データへの影響 | 対応 |
|---|---|---|
| gmail_accounts → mail_accounts rename | 既存コードは全 import を変更 | grep + 一括置換、CI で確認 |
| adapter 列追加 (default 'gmail') | 既存行は自動 'gmail' で埋まる | DEFAULT 句で吸収 |
| intake_adapter / external_message_id 列追加 | 既存 mail_messages も migration で埋まる | UPDATE 句で gmail_message_id から copy |
| 旧 gmail_message_id / gmail_thread_id 列 | 当面残す (= rollback 保険) | Phase Z で drop |
| API `/api/mail/accounts` 新規 | 既存 `/api/gmail/accounts` も併存 | 後者は deprecated、Phase H4 で internal redirect |

---

## 14. 既知の限界

- **Exchange / O365 専用 API** (EWS / Graph API) はサポート外、IMAPS で代替 (= 機能制限あり、サーバ側でラベル / カテゴリが取得できないなど)
- **POP3S は隔離不可** (= フォルダ移動できない)、脅威検出時は通知のみ
- **OAuth2 が必要な IMAPS** (= 例: Gmail IMAP の XOAUTH2、Microsoft の OAuth) は MVP では ID/PW のみ、Phase H5+ で対応
- **mailparser のメモリ使用量**: 大きな添付付きメールで RAM 使用が増える → 大容量メール (>5MB) は本文だけ抽出して添付は ref 保持に

---

## 15. リスク / 注意

- **TLS 必須でも、サーバ側証明書が無効** だと接続失敗。user に分かりやすい error message が必要 (= 「証明書が無効です」を固定文化、raw error は server log)
- **password 変更タイミング**: ユーザがメールサーバ側で password を変えた場合、次の poll で失敗 + `last_connect_error` に記録、UI でアラート
- **IMAP IDLE 対応**: imapflow は IDLE (= push 受信) をサポートしているが、MVP では polling のみ (= 10 分間隔)。Phase H5 で IDLE 実装で「即時取得」を実現可能
- **大量 inbox**: 数十万件の inbox を持つ user で初回同期が爆発する可能性 → `initialSyncDays` で過去 N 日に制限

---

## 16. 監査スクリプト

```bash
# adapter 別の account 数を集計
SELECT adapter, COUNT(*) FROM mail_accounts GROUP BY adapter;

# 平文 password が DB に存在しないか確認 (= 暗号文は base64 系で長い)
SELECT id, adapter, email, length(encrypted_password) AS pwlen
FROM mail_accounts
WHERE encrypted_password IS NOT NULL;
-- length が短い (< 40) なら暗号化されてない疑い

# log に password / token が出ていないか grep
grep -rn "password\|encrypted_password\|RFC822" /app/logs/
```

---

## 17. 将来拡張余地

- **OAuth XOAUTH2** (= Gmail IMAP / Office 365 IMAP) 対応 (= ID/PW より安全)
- **IMAP IDLE** で push 受信化 (= 10 分 polling から即時取得へ)
- **SMTP 送信** 統合 (= 既存 Gmail compose の汎用化、IMAPS/POP3 用送信)
- **CalDAV / CardDAV** (= 非 Google のカレンダー / 連絡先取り込み、別 doc が必要)
- **Self-signed cert support** (= 個人 LAN サーバ、信頼する CA を user 登録)
- **削除 account の過去メール一括削除**: 別 endpoint `/api/mail/accounts/<id>/purge`
- **adapter 別の取得頻度設定** (= POP3 は高頻度、IMAPS IDLE があれば polling 不要 等)
- **多 user 化** (= Yui SaaS 化する場合、account を user に紐付ける migration)

---

## 18. コミット規約

- 新規 dependency 追加 (= `imapflow`, `node-pop3`, `mailparser`) は CLAUDE.md §dependency に従い理由説明 + lockfile commit + npm audit
- migration は `IF NOT EXISTS` で idempotent
- Commit message は `Phase H1: mail-intake adapter foundation — ...` のように Phase 番号 prefix
- API route の catch は必ず `clientError()`

---

## 19. 関連ドキュメント

- [`docs/mail-system.md`](mail-system.md) — メール処理全体の設計
- [`docs/mail-classification.md`](mail-classification.md) — 重要度分類
- [`docs/mail-threat-detection.md`](mail-threat-detection.md) — 脅威検出 (= 本書の intake adapter 構造を参照)
- [`docs/file-security.md`](file-security.md) — 添付スキャン + ClamAV (= mail-threat-detection §G6 から派生)
- [`CLAUDE.md`](../CLAUDE.md) — 規約 (= エラー処理 / 暗号化 / 依存管理)
