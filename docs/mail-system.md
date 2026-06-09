# メール統合システム 設計書

> **本書はメール統合の上位 / 索引設計書**。詳細は以下の専門設計書を参照:
>
> - **[`docs/mail-classification.md`](mail-classification.md)** — 重要度分類 (= important/needed/unneeded、Gemma RAG)
> - **[`docs/mail-accounts.md`](mail-accounts.md)** — 多 provider 対応の取り込み層 (= Gmail / IMAPS / POP3S adapter)
> - **[`docs/mail-threat-detection.md`](mail-threat-detection.md)** — フィッシング / 詐欺 / なりすまし検出 (= 6 層多層防御)
> - **[`docs/file-security.md`](file-security.md)** — 専用 `mail-security` コンテナ (= ClamAV / URL HEAD / threat intel feed)
>
> 本書 §4 のスキーマ (= `gmail_accounts`, `mail_messages`) は mail-accounts.md で一般化された (= 列追加 / rename) ことに注意。歴史的経緯として残しつつ、現行スキーマは mail-accounts.md を正本とする。

## 1. 背景と目的

現状は Gmail を Yui の context 用に readonly 参照しているだけで、ご主人様は
日常的に Gmail Web/アプリを開いて確認・返信する運用。これには:

- ブラウザのコンテキスト切り替えが多い (Yui の前から離れる)
- 複数アカウントは Google 側で per-account に分かれていて横断ビューがない
- スパム / ニュースレター / 営業メールが大量で、本当に重要な数件が埋もれる

そこで Yui の中に「メール秘書」機能を載せ:

1. **複数 Gmail アカウントを 1 つの受信箱として集約**
2. **Yui のキュレーションで重要メールだけを目立たせる** (ニュースキュレーションと同じ流儀)
3. **アプリ内から送信・返信できる** (ブラウザ Gmail を開かなくて済む)
4. **朝のブリーフ / 通知に統合** ("夜中に重要メール 3 件" のように Yui の口で言う)

### 設計原則

- **Gmail を Single Source of Truth として尊重** — 全ミラーは作らない
- **同期は一方向 (Gmail → 自 DB)** — 自 DB 側の状態 (既読・スター・削除等) は
  Gmail へ書き戻さない
- **自 DB で削除したら再同期しない** — 「アプリでは消えた」が永続
- **個人プロファイル特化**: 興味プロファイル (news と共有 or 別管理) で
  「ご主人様にとって重要」を学習可能な仕組みを Yui のキャラ性込みで提供
- **Gemini in Gmail との差別化**: 単なる分類ではなく、Yui の口で要約 / 行動
  (todo 化 / 下書き) まで一気通貫

---

## 2. 同期方針 (一方向 pull-only)

```
取得: Gmail → 自 DB (periodic poll, 5-10 min)
送信: アプリ → Gmail API direct (users.messages.send)
      → 送信メールは次の poll で Sent ラベルから自 DB に逆流入
削除: アプリ → 自 DB のみ (deleted_at flag)
      → Gmail は触らない、再 poll でも復活させない
既読 / スター / 重要マーク: 自 DB ローカル状態のみ
      → Gmail とは独立、双方向同期なし
```

「アプリで既読にした → Gmail では未読」「Gmail でアーカイブ → アプリには残る」
という非対称が起こりうるが、これは **意図的**。「アプリは Yui がキュレーションした
ご主人様専用の view、Gmail は元データ」というメンタルモデルを保つ。

### 「削除したら再同期しない」の実装

`mail_messages` テーブルに `deleted_at TIMESTAMPTZ` を持ち、INSERT 時に
`ON CONFLICT (gmail_message_id) DO NOTHING` を使う。同じ `gmail_message_id`
が再度 fetch されても既存行 (deleted_at が立っているもの含む) を保護する。

つまり:
- 自 DB に既に存在 → 何もしない (deleted_at が NULL でも、立っていても)
- 自 DB に存在しない (初回 or 削除後に物理削除) → INSERT
- 物理削除を選んだ場合は別途 tombstone テーブルが必要だが、v1 は soft-delete で
  済ませて tombstone は持たない (`deleted_at` 自体が tombstone)

---

## 3. アーキテクチャ概要

```
[Gmail API] ───┐
               │ poll (5-10 min)
               ▼
   ┌─────────────────────────────┐
   │ mail-poll periodic module    │
   │  - 各 enabled アカウント並列  │
   │  - 直近 24h headers list     │
   │  - 個別 metadata は新規分のみ │
   └────────┬────────────────────┘
            │
            ▼
   ┌─────────────────────────────┐
   │ mail_messages (header only)  │ ← deleted_at で永続非表示
   │  (gmail_message_id 主キー)   │
   └────────┬────────────────────┘
            │
            ▼ 新規行を batch curate
   ┌─────────────────────────────┐
   │ Haiku curation               │
   │  入力: 興味プロファイル +     │
   │        from / subject / snippet
   │  出力: score + reason         │
   └────────┬────────────────────┘
            │
       閾値判定
            │
   ┌────────┴───────┐
   ▼                ▼
score >= 閾値    score <  閾値
   │                │
   ▼                ▼
body fetch         silent (header だけ残す)
+ お便り通知       受信箱の「全件表示」では見える
+ 朝のブリーフ
  対象
```

---

## 4. スキーマ

### 4.1 `gmail_accounts` (multi-account)

```sql
CREATE TABLE gmail_accounts (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  display_name  TEXT,
  enabled       BOOLEAN NOT NULL DEFAULT true,
  is_primary    BOOLEAN NOT NULL DEFAULT false,  -- 新規作成時の default from
  -- OAuth token は別 table (google_tokens) で email でリンク
  -- そっちは既存の google-oauth.ts の仕組みを流用
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_synced_at TIMESTAMPTZ
);

-- 1 アカウントだけが is_primary=true になるよう partial unique index
CREATE UNIQUE INDEX gmail_accounts_one_primary
  ON gmail_accounts (is_primary) WHERE is_primary = true;
```

`google_tokens` テーブルは既存。`email` 単位で複数行持てるよう拡張する
(現状は singleton 想定なら別 migration で `UNIQUE(email)` 化)。

**from アカウントの default 解決ルール**:
- 返信 / 全員返信 / 転送 → 元メールの受信アカウント (= 元の宛先) を自動採用
- 新規作成 → `is_primary=true` のアカウント
- Yui の `compose_mail` も同じルール。`reply_to_message_id` あれば元メールの
  アカウント、なければ primary

### 4.2 `mail_messages` (header + curation 結果)

```sql
CREATE TABLE mail_messages (
  id                 BIGSERIAL PRIMARY KEY,
  gmail_message_id   TEXT NOT NULL,         -- Gmail の messages.id
  gmail_thread_id    TEXT NOT NULL,         -- 表示時のグループ化に使う
  account_id         BIGINT NOT NULL REFERENCES gmail_accounts(id) ON DELETE CASCADE,

  -- header
  from_address       TEXT NOT NULL,         -- "Foo <foo@example.com>"
  from_name          TEXT,                  -- "Foo"
  from_email         TEXT NOT NULL,         -- "foo@example.com"
  to_addresses       TEXT[],                -- 複数宛先対応
  subject            TEXT,
  snippet            TEXT,                  -- Gmail snippet (~150 chars)
  received_at        TIMESTAMPTZ NOT NULL,
  labels             TEXT[],                -- Gmail labels (INBOX, SENT, IMPORTANT...)

  -- curation
  score              REAL,                  -- NULL = 未 curate、0.0-1.0
  score_reason       TEXT,
  curated_at         TIMESTAMPTZ,

  -- 本文 (閾値超え時のみ fetch、最初は NULL)
  body_text          TEXT,                  -- text/plain
  body_html          TEXT,                  -- text/html (rendering 用)
  body_fetched_at    TIMESTAMPTZ,

  -- アプリローカル状態 (Gmail とは独立)
  read_at            TIMESTAMPTZ,           -- アプリ内で既読化した時刻
  starred_at         TIMESTAMPTZ,           -- アプリ内スター
  deleted_at         TIMESTAMPTZ,           -- 自 DB で削除 (Gmail は触らない)

  inserted_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE (gmail_message_id, account_id)
);

CREATE INDEX idx_mail_received ON mail_messages (received_at DESC)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_mail_score    ON mail_messages (score DESC NULLS LAST)
  WHERE deleted_at IS NULL;
CREATE INDEX idx_mail_thread   ON mail_messages (gmail_thread_id);
```

`gmail_message_id` がアカウント間で衝突しない保証はない (実際には UUID-like で
ほぼないが) ので `UNIQUE (gmail_message_id, account_id)`。

### 4.3 `mail_attachments` (metadata only)

```sql
CREATE TABLE mail_attachments (
  id              BIGSERIAL PRIMARY KEY,
  message_id      BIGINT NOT NULL REFERENCES mail_messages(id) ON DELETE CASCADE,
  filename        TEXT NOT NULL,
  mime_type       TEXT,
  size_bytes      BIGINT,
  gmail_part_id   TEXT,                  -- Gmail から fetch するためのキー
  inserted_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

**実体ファイルは自システムに一切保存しない**。ユーザがクリックした時点で
都度 Gmail API から fetch → ブラウザに stream して即破棄。理由:

- 添付には実行可能ファイル / マクロ付き Office / 悪性 PDF 等が混在しうる
- 自 DB やディスクに persist すると、サーバ自身を汚染する可能性
- Gmail 側のスキャナを尊重する (Google のウィルススキャン結果を信頼)
- 容量問題も自動回避

**送信時の添付も同じ方針**:
- 送信モーダルの「📎 ファイル選択」で選んだファイルは、
  user のブラウザから直接 multipart で Gmail API に乗せて send
- 自 server / 自 DB は中継しない (FormData → fetch で Gmail に直送)
- 送信後ファイルは Gmail Sent に残り、次回 poll で attachment metadata だけ
  自 DB に流入する

将来、もし Gmail がサービス終了したらローカル保管を検討するが、現状その兆候は
ないので「Gmail = 永続保管庫」の方針で割り切る。

### 4.4 `mail_curation_settings` (singleton, news と類似)

```sql
CREATE TABLE mail_curation_settings (
  id INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  interest_profile  TEXT NOT NULL DEFAULT '',  -- news と別管理
  score_threshold   REAL NOT NULL DEFAULT 0.5,
  -- 「VIP」: from_email がここに入っていれば自動的に score=1.0 扱い
  vip_addresses     TEXT[] NOT NULL DEFAULT '{}',
  -- 「block」: ここに含まれる送信者は自動的に score=0 + curate skip
  blocked_addresses TEXT[] NOT NULL DEFAULT '{}',
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

news と別管理にしている理由: メールの「重要さ」は news と判定軸が違う
(送信者の人間関係、件名の緊急性、添付の有無 etc.)。

---

## 5. キュレーション (ローカル LLM: Gemma 4 26B on AI Max+ 395)

### 5.1 バックエンド方針 — ローカル LLM 採用

メール curation には **Anthropic API ではなく自前のローカル LLM** を使う。

採用モデル:
- **Gemma 4 26B (A4B, MoE active 4B)** on Ryzen AI Max+ 395 (96GB VRAM)
- 量子化: `gemma-4-26B-A4B-it-UD-Q5_K_M.gguf` (Unsloth dynamic Q5)
- アクセス: Tailscale 越し `http://llm:8081/v1/chat/completions` (OpenAI 互換)

なぜローカル LLM か:

| 観点 | Anthropic Haiku | ローカル Gemma |
|---|---|---|
| **プライバシー** | メール本文を外部送信 | **完全ローカル**、外部に出ない |
| ランニングコスト | 月 $2-3 | 電気代のみ |
| レイテンシ | 2-3 秒/batch | ~5 秒/30件、許容範囲 |
| 判定品質 | 高 | 同等 (動作確認済、下記) |
| 障害時挙動 | Anthropic 障害で停止 | LLM サーバー停止で停止 → fallback 設計が必要 |

特に **プライバシー** が決定要因。メール本文には認証情報・個人連絡・契約等の
機微情報が混ざるため、外部 LLM API に流すのは個人秘書の信頼設計と相性が悪い。
ニュースタイトルが公開情報なのとは性質が違う。

### 5.2 score 算出

- VIP リストに入っている from_email → score = 1.0 (即時 pass、LLM skip)
- ブロックリストに入っている from_email → score = 0.0 (即時 skip)
- それ以外: Gemma batch (20-30 件まとめて)

入力 (Gemma に投げる):
```
[system]
あなたはメール秘書です。ご主人様の興味プロファイルに沿って、各メールに 0.0-1.0
のスコアと簡潔な理由をつけてください。

判定基準:
- 0.8-1.0: 重要 (人間からの直接連絡、緊急、契約 / 請求の重要更新等)
- 0.5-0.8: 関連あり (興味分野の通知、定期的に読むメルマガ等)
- 0.2-0.5: 弱い関連 (リマインダ、確認系)
- 0.0-0.2: ノイズ (広告、無関係なニュースレター、営業)

from_email の人間性 (個人 vs no-reply) と件名 / snippet を総合判断する。

出力は JSON 配列のみ。各メールに 1-based の idx を必ず含めること:
[{"idx": 1, "score": 0.9, "reason": "..."}, ...]

説明文・装飾不要。コードフェンス不要。

[user]
## 興味プロファイル
{interest_profile}

## メール一覧 (idx は 1-based)
1. from: "Foo <foo@example.com>"
   subject: "..."
   snippet: "..."
2. ...
```

実装上の注意 (テストで判明):
- Gemma は出力に \`\`\`json ... \`\`\` フェンスを付けがち → reconcile.ts と同じ
  正規表現で剥がす
- `idx` 出力をプロンプトで明示しないと省略されることがある (上記で明示済)
- JSON parse 失敗時はその batch を silent skip + warn ログ (curation 失敗で
  通知の品質を下げない方向に倒す)

### 5.3 接続実装

既存の `src/lib/classifier.ts` (LFM-2.5 用) と並び立てる形で **新規** に
`src/lib/local-llm.ts` を切り出す:

```ts
// 役割ごとに endpoint と model を持つ汎用 OpenAI 互換 wrapper
export type LocalLlmRole = "mail_curate" /* | "他" */;

export async function callLocalLlm(role: LocalLlmRole, opts: {
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  maxTokens?: number;
  temperature?: number;
}): Promise<{ text: string; usage: { input: number; output: number } }>
```

設定は **AI 設定 (SettingsModal「AI」タブ)** で UI から変更可能にする
(後述 §8.5)。env はデフォルト値として残し、DB 設定があれば優先。

### 5.4 性能・コスト

実測 (Gemma 4 26B Q5 on AI Max+ 395):
- 5 メール batch: prompt 717ms + 生成 4.4 秒 = **合計 5.1 秒**
- ~1 メール/秒の生成速度
- 30 件 batch なら ~30 秒。1 時間ごと poll なら問題なし

ランニングコスト: **電気代のみ**。月額の API 課金は発生しない。

### 5.5 フォールバック (確定: 未 curate でも全件表示)

ローカル LLM サーバーが落ちている / Tailscale 切断時:
- 1 回 retry (5 秒間隔)
- 失敗継続なら curate を skip、`score = null` のまま DB に残す
- **受信箱は未 curate メールを時系列で全件表示**、行に「未判定」バッジを表示
- ご主人様はあとで再起動 / Tailscale 復旧後に手動 re-curate トリガー可
  (MailModal ヘッダに「再キュレーション」ボタン)

「受信箱が空に見える」ことが最悪 (重要メールを見逃す) なので、curation 失敗時は
ザル状態でも見える方を優先する。

将来オプション: AI 設定で「ローカル LLM 不在時は Anthropic Haiku にフォールバック」
を有効化できるようにする。デフォルトはオフ (プライバシー優先)。

### 5.6 body fetch

`score >= threshold` 時のみ Gmail API で body 全文 + 添付メタを取得。
別 fetch なので per-message レイテンシ vs API quota の balance を見る。

---

## 6. UI

### 6.1 MailModal (新規)

ゲーム UI 流儀で TodoModal や ContactsModal 同様に **2 ペイン構成**:

- **左ペイン**: メール一覧 (デフォルト score 順 or 時系列、トグル)
  - 行: from name / アカウントバッジ (どの Gmail から来たか) / subject / snippet 1 行 / 受信時刻 / score バッジ
  - 複数アカウントは行内のバッジで識別、別タブにはしない (集約ビューが本機能の主眼)
  - 閾値以下の行はデフォルト折りたたみ、「⬇ 興味なさそうな X 件」で展開
  - 右クリック (or 長押し) でコンテキストメニュー (§6.2)
- **右ペイン**: 選択中メールの本文 (text or HTML safe-render)
  - 上部にスレッド一覧 (gmail_thread_id でグループ化)
  - 下部にアクションバー: 返信 / 全員返信 / 転送 / アーカイブ (= deleted_at) / 下書き Yui

### 6.1.1 HTML body の render: iframe sandbox (確定)

Gmail HTML には外部 image / tracking pixel / CSS / JS が混ざるので、
**sandboxed iframe で隔離 render** する:

```html
<iframe
  srcdoc="<base target='_blank'><style>img{max-width:100%}</style>{html}"
  sandbox="allow-same-origin"
  ...
/>
```

- `sandbox="allow-same-origin"` のみ (script なし、form なし、popup なし)
- `<base target="_blank">` でリンクは全部新窓
- 外部 image は読み込まれる (= 開封トラッキング通知される) が、対策は v2:
  - Content-Security-Policy で外部 image をブロック (CSP の img-src を 'self' に)
  - またはサーバ proxy 経由で取得 (sender に IP を渡さない)
- text/plain 優先表示モードを設定で持つ (paranoid モード)

「フォルダ的ビュー (受信 / 送信 / スター)」は、左ペイン上部にフィルタチップとして
横並びに置く。アカウント切り替えタブは作らない (全アカウント常時集約)。

### 6.2 右クリックコンテキストメニュー

メール一覧の行を右クリック (touchscreen は長押し) で表示:

- **既読 / 未読切替**
- **スターを付ける / 外す**
- **アーカイブ** (= 自 DB deleted_at セット、Gmail は触らない)
- ---
- **VIP に追加** (送信者を vip_addresses に登録、以降 score=1.0 即 pass)
- **ブロックに追加** (送信者を blocked_addresses に登録、以降 score=0 で silent)
- ---
- **todo に変換** (件名 / snippet から todos に行追加、ref で元メール link)
- **Gmail で開く** (`https://mail.google.com/.../{message_id}` を新窓)

### 6.2 Compose modal

- 宛先 / cc / bcc / 件名 / 本文 / 添付
- アカウント選択 (multi-account)
- 「Yui に下書きさせる」ボタン → Sonnet で本文 draft → 編集可能フィールドに流し込み
- 送信 → Gmail API `users.messages.send`
- 下書き保存 → Gmail API `users.drafts.create` (自 DB には書かない、次の poll で流入)

### 6.2.5 送信 / 下書き モーダル (Compose Modal)

MailModal のヘッダから「新規作成」、または既存メールから「返信 / 全員返信 / 転送」で
**送信モーダル** を開く。以下の構成:

```
┌─ 送信モーダル ────────────────────────────────────────────┐
│ アカウント [▼ from@example.com]                          │
│ 宛先       [____________________________] [📒 連絡先から] │
│ Cc         [____________________________]                │
│ Bcc        [____________________________]                │
│ 件名       [____________________________]                │
│ ┌──────────────────────────────────────────────────────┐ │
│ │                                                      │ │
│ │  本文 textarea                                       │ │
│ │                                                      │ │
│ └──────────────────────────────────────────────────────┘ │
│ 添付: [📎 ファイル選択]                                  │
│                                                          │
│ [ゆいに校正させる] [ゆいに返信を書かせる*]               │
│                                                          │
│        [下書き保存] [キャンセル] [📤 送信]              │
└──────────────────────────────────────────────────────────┘
* 返信 / 転送モード時のみ表示。新規作成は校正だけ
```

#### 主要機能

1. **ゆいに返信を書かせる** (返信 / 転送モード)
   - 元メール (場合により thread 全体) を context に渡す
   - 「了承」「断り」「保留」「単純確認」等の返信意図プリセットボタン
   - LLM (Sonnet) で返信本文を生成 → 本文欄に流し込み
   - user 編集後送信

2. **ゆいに校正させる** (新規 / 返信両方)
   - 現在の本文を Sonnet に渡し、**常に丁寧 (敬語ビジネス調)** で整形
   - 文体プリセットの選択肢は持たない (シンプルに固定)
   - **左右並びの差分表示画面** に遷移:
     ```
     ┌─ 校正結果 ────────────────────────────────┐
     │ ┌─ 元の本文 ──┐ ┌─ 校正後 ────────────┐  │
     │ │             │ │                       │  │
     │ │             │ │                       │  │
     │ └─────────────┘ └───────────────────────┘  │
     │              [採用] [キャンセル]           │
     └────────────────────────────────────────────┘
     ```
   - 「採用」 → 本文を校正後で置換 + 1 画面 (送信モーダル) に戻る
   - 「キャンセル」 → 何もせず戻る

3. **連絡先から宛先選択** (📒 ボタン)
   - mini-popup で contacts.emails のあるエントリを検索可能リストで表示
   - 名前 / 会社 / メールアドレスでフィルタ
   - クリックで宛先欄に追加 (複数選択可)
   - autocomplete も別途、宛先欄入力時に contacts から suggestion

4. **下書き保存**
   - Gmail Drafts に直接保存 (`users.drafts.create`)
   - 次の poll で逆流入して受信箱の「下書き」フィルタから見える
   - 自 DB の独自下書きテーブルは作らない
   - **保存成功後はモーダルを自動で閉じる** (確認ダイアログなし)

5. **送信は必ず user**
   - 「📤 送信」ボタンは user の明示クリックでのみ実行
   - server endpoint も `/api/mail/draft` (Yui からも呼べる) と
     `/api/mail/send` (user UI からのみ) を分離
   - Yui の tool には **送信権限を与えない** (下書きまで)

### 6.3 SettingsModal「メール」タブ (新規)

- gmail_accounts 一覧 (追加 / 削除 / 有効無効)
- 興味プロファイル textarea (news とは別)
- 閾値スライダー
- VIP / ブロックリスト (アドレス手入力 or 受信箱から「VIP に追加」)

---

## 7. Yui 統合

### 7.1 朝のブリーフへの統合

`buildMorningBriefMarkdown` / `buildMorningBriefPrompt` のメール section を
新 schema に置き換える。「夜中に重要メール N 件」のように curate 通過の件数 +
代表 1-3 件のタイトルを含める。

### 7.2 通知

メール着信時の通知マトリックスは既存 `notification_settings` の `mail_important`
と `mail_other` を流用。判定軸を:
- score >= 0.8 → `mail_important` ルールに従う (default: online で speak、それ以外 notify)
- それ未満 → `mail_other` (default: notify only)
- 閾値以下 → 通知すらしない (silent)

### 7.3 Yui 経由のメール下書き (チャット → Compose Modal)

#### 設計原則

- **Yui に送信権限は無い**。下書き作成までで完結
- 必ず送信モーダルが開き、user が内容を確認 → 「📤 送信」を明示クリックして送信
- 「自動送信」「確認なし送信」は実装しない (誤送信は取り返しがつかない)

#### Tool 設計

Yui の tool に以下を追加 (chat route の specialist 経由 or 直 tool):

```ts
tool: compose_mail
  inputs:
    to:              string | string[]   // メアド or 名前 (名前は contacts 解決)
    subject?:        string               // 省略時は body から AI 生成
    body_hint:       string               // 自然言語の意図 ("お礼" "了承" "確認依頼" 等)
    account_email?:  string               // どの from で送るか (省略時はデフォルト)
    reply_to_message_id?: number          // 返信なら元メール ID
    intent?: "reply_agree" | "reply_decline" | "reply_hold" | "new" | "thank_you" | "follow_up"
  effect:
    1. 名前 → contacts.emails の解決 (複数候補あれば user に選ばせる)
    2. 元メール / contacts / 関連 memory を context に集約
    3. Sonnet で本文 draft 生成
    4. SSE で `open_compose_modal` event push → frontend がモーダル開く
    5. モーダルには宛先 / 件名 / 本文すべて埋まった状態
```

#### UX フロー例

**例 1: 新規メール下書き**

```
user: ゆい、メール書いて。Goen さんに新しい機能ができたので確認してくださいという内容
↓
Yui (tool 呼び出し): compose_mail(
  to: "Goen さん",
  body_hint: "新しい機能ができたので確認してください",
  intent: "follow_up"
)
↓
server: contacts.emails から "Goen" 検索 → goen@example.com
       Sonnet で「お世話になっております。〜新機能の確認のお願い〜」生成
       SSE push: open_compose_modal({to, subject, body, account})
↓
frontend: 送信モーダルが開く、全部埋まった状態。user 編集 → 送信
↓
Yui: 「下書きを開きました。よろしければそのまま送信ください」 (応答)
```

**例 2: お便り通知への返信**

```
user: さっきの (お便り通知の) ◯◯さんからのメール、了承で返信して
↓
Yui (tool 呼び出し): compose_mail(
  reply_to_message_id: <直近の重要メール>,
  intent: "reply_agree"
)
↓
server: 元メール本文を読み、了承の返信を Sonnet で生成
       open_compose_modal SSE push
↓
frontend: 送信モーダル (返信モード) が開く、宛先 / 件名 / 本文埋まった状態
```

**例 3: memory から context 取得**

```
user: 田中さんにお歳暮のお礼メール書いて
↓
Yui:
  1. memory から「田中さんからお歳暮もらった」イベントを retrieval
  2. contacts から田中さんのメール解決
  3. お礼の文体で本文 draft
  4. open_compose_modal push
```

### 7.4 メールから todo 化

- メール右ペインで「これを todo に」ボタン → todos に追加 + ref で元メール link
- LLM の手を借りずに件名から自動生成

### 7.5 住所録 (contacts) 連動

既存 `contacts` テーブルの `emails: jsonb [{ type, value }]` を流用:

- **送信モーダルの宛先欄**: 入力時 autocomplete (名前 / company / email で match)
- **📒 連絡先ボタン**: mini-popup で contacts 検索リスト、メールあるエントリのみ表示
- **Yui からの名前解決**: tool の `to: "Goen さん"` → contacts.name で前方一致 / 部分一致検索
  - 複数候補ヒット時はモーダル内に「候補から選択」UI を表示
  - 0 件ヒット時は宛先欄を空にして user に直入力させる
- **新規連絡先追加**: メール受信箱から「この送信者を連絡先に追加」(右クリックメニュー §6.2)
  - 既存の contacts CRUD UI を流用

### 7.4 メールから todo 化

- メール右ペインで「これを todo に」ボタン → todos に追加 + ref で元メール link
- LLM の手を借りずに件名から自動生成

---

## 8. 実装フェーズ

### Phase A — multi-account + header poll

- DB migration: `gmail_accounts`, `mail_messages`, `mail_attachments`, `mail_curation_settings`
- `src/lib/mail-accounts.ts`: アカウント CRUD
- `src/lib/google-oauth.ts` 改修: per-email token storage
- `src/periodic/mail-poll.ts`: 5-10 min interval で全 enabled アカウントを fetch
- まだ curation も UI も無い、DB に貯まるだけの段階

### Phase B — curation

- `src/lib/mail-curate.ts` (Haiku batch、VIP / block 即時判定込み)
- mail-poll の末尾で curate 起動
- score >= threshold → body fetch (Gmail から再取得して mail_messages に書き戻し)

### Phase C — MailModal UI (受信側のみ)

- 既存 IconBar にメールアイコン追加
- 左 / 中 / 右ペイン構造、ゲーム UI で
- 既読化 / スター / アーカイブ (= deleted_at) のアプリローカル操作
- 全件表示モード (閾値以下も見えるトグル)

### Phase D — 送信 / 返信

- Compose modal
- Gmail API scope `gmail.send` 追加 → 再 connect 必要
- 「Yui に下書き」連携

### Phase E — Yui 統合

- 朝のブリーフのメール section を新 schema に
- 通知マトリックスの `mail_important` / `mail_other` 経路と接続
- tool `compose_mail`, `find_mail`, `summarize_thread` 等

---

## 9. リスク / 制約

### 9.1 Gmail API quota

- メタデータ list: 1 quota unit / 1 request
- get individual message: 5 quota / req
- 日次 quota は通常 1B unit、個人運用ならまず当たらない
- ただし複数アカウント × 短い poll 間隔 でやりすぎると注意。poll は 5-10 min が
  実用解、新着フラグで早期 break

### 9.2 OAuth scope 拡張

- 現状 `gmail.readonly`
- Phase D で `gmail.send` 追加 → 一度 disconnect → 再 connect が必要 (ユーザー操作)
- 設計書 §google-oauth-setup.md 更新

### 9.3 HTML body の安全 render

- Gmail の HTML は外部 image / tracking pixel / JS いろいろ
- DOMPurify か iframe sandbox で render
- v1 は text/plain 優先表示、HTML はリンクで Gmail Web に開く逃げもアリ

### 9.4 スレッド表現

- メッセージ単位主体、表示時に thread_id でグループ化
- 完全な thread tree (Reference / In-Reply-To で再構成) はしない
- Gmail の thread が安定して thread_id を返してくれる前提

### 9.5 アカウント追加時の初回同期量

- 過去メール全部は取らない (時間 / quota / DB 容量)
- **初回は過去 3 日のみ** fetch、以降は increment
- 設定で変更可 (将来)

### 9.6 「Gemini in Gmail」との競合

- Google が分類精度 / 要約品質を上げてくる
- 差別化: 個人プロファイル + 複数アカウント横断 + 秘書としての行動 (todo 化 / 下書き)
- 「分類だけ」では負けるので Yui の介在価値で差をつける

### 9.7 ローカル LLM サーバーの可用性

- AI Max+ 395 が起動していない / Tailscale 切断 → curate 不能
- 対処は §5.5 (fallback)
- 長期停止が頻発するなら「AI 設定」で Haiku fallback を有効化可

---

## 10. テスト計画

### Manual

1. アカウント 1 つで Phase A 動作確認 → DB に header が貯まる
2. 興味プロファイル設定 → curation で score 分布チェック
3. VIP / ブロック登録 → 即時挙動
4. MailModal で受信表示 / 既読 / スター / アーカイブ → DB local だけ更新確認
5. Gmail でアーカイブ → アプリには残る (一方向確認)
6. アプリで削除 → Gmail に残る、再 poll でも復活しない確認
7. Compose → Gmail Drafts に保存される確認
8. 送信 → Sent から逆流入確認
9. 朝のブリーフにメール section が組み込まれる
10. 複数アカウント追加 → 集約ビュー

### Automated (将来)

- mock Gmail API + curation の deterministic test
- v1 は手動で十分
