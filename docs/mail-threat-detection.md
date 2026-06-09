# メール脅威検出 (フィッシング / 詐欺 / なりすまし / スパム) 設計書

## 0. 本書の位置付け

### 0.1 既存設計との関係

既存の **`docs/mail-classification.md`** (= 重要度振り分け、`important / needed / unneeded` の 3 値分類) は **「ご主人様の手が動く必要があるか」軸** だけを判定しており、**フィッシング / なりすまし / 詐欺メールに対する systematic な検出ロジックを持たない**。

本書は curate (重要度) **と並列に走る、独立した脅威監査パス** を追加する設計。

関連設計書 (= 本書から派生 / 参照):
- **`docs/mail-accounts.md`** — 複数 provider 対応の取り込み層 (= Gmail/IMAPS/POP3S adapter)。本書 §3.2 の intake-adapter 抽象化はそちらで詳述
- **`docs/file-security.md`** — 専用 `mail-security` コンテナによる ClamAV / URL HEAD / threat intel feed 統合。本書 §2.4 / §2.5 / §G6 のスキャンは file-security 経由で実装される

### 0.2 設計レベル

**自己ホスト OSS の制約下で達成できる「エンタープライズ相当」を狙う**。具体的には:

- 取り込み層を **protocol-agnostic** に: Gmail API / IMAPS / POP3S のいずれからでも取り込まれた `mail_messages` 行に対して動作。Gmail 固有実装を前提にしない
- **多層防御**: LLM 単独判定ではなく、静的ルール / 脅威インテリ / URL 解析 / 行動分析 / LLM / ML を **score 合算** で総合判定。LLM は signal の 1 つに過ぎない
- **隔離フロー**: 通知だけでなく、provider-agnostic な quarantine (= IMAP の Quarantine フォルダ / Gmail の隔離ラベル等) + ユーザのリリース動線
- **無料 / OSS で詰められる範囲を最大限まで**: PhishTank / OpenPhish / Spamhaus DBL 等の無料 feed、WHOIS、Google Safe Browsing (opt-in)、Damerau-Levenshtein による lookalike domain 検出

### 0.3 想定する脅威モデル

- 「ご主人様の関係者の名前を騙る」ターゲット型フィッシング (= 表示名スプーフィング + lookalike domain)
- ブランドなりすまし (= 「Apple」「楽天」「三菱 UFJ」等の名義で偽装)
- ビジネスメール詐欺 (BEC、= 偽請求書、CEO 詐欺、wire transfer 誘導)
- 認証情報奪取 (= phishing キット URL、QR コード経由の LINE 移行)
- マルウェア配布 (= スコープ外、Phase G6+ で議論)

### 0.4 設計レベルの限界 (= honest disclosure)

商用エンタープライズ製品 (Proofpoint / Mimecast / Microsoft Defender 等) と比較した時、本設計が **物理的に達成できないこと**:

- **添付ファイル sandbox 実行** (= cuckoo / 商用 sandbox 必要、OSS でも数台のサーバ要)
- **画像ベースのブランド impersonation 検出** (= 画像 ML モデルが必要)
- **商用 threat intel feed** (= Proofpoint TIP / Recorded Future 等は契約料金高)
- **大規模 honeypot 連携** (= 自社で運営できる規模ではない)
- **メールサーバゲートウェイレベルでの reject** (= 既に受信した後の post-delivery filter であり、SMTP 段階で拒否はできない)

これらは「個人ホスト OSS では到達できない領域」として認め、本設計のスコープ外。ご主人様には UI に「Yui の判定です、最終判断はご主人様で」と注記を出す。

---

## 1. 検出すべき脅威カテゴリ

### 1.1 ターゲット型フィッシング (spear phishing)

ご主人様の関係者 / 取引先 / 利用サービスを騙って認証情報 / 個人情報 / 金銭を奪取する。

red flag 例:
- **表示名スプーフィング**: 表示名は実在の関係者名 (= 架空例「山田太郎」、以下本書中の人物名は全て **架空例**、ご主人様の関係者を想定したフィッシング fixture として用いる) だが、送信元ドメインが outlook.com / hotmail.com / gmail.com 等の generic webmail
- **lookalike ドメイン**: 取引先のドメインに 1-2 文字差 (= `apple.com` → `apple-secure.com` / `аpple.com` (Cyrillic а))
- **会話履歴に被せた偽装**: 既存スレッドの返信を装うが、In-Reply-To ヘッダや thread continuity が破綻
- **QR コード送付要求**: 監視外チャネル (LINE / Telegram) に引きずり出して攻撃継続
- **認証情報請求**: パスワード / 二段階認証コード / クレジットカード番号の入力誘導

### 1.2 ブランドなりすまし (brand impersonation)

公式サービス (Apple / Google / 三菱 UFJ / 楽天 / Amazon 等) を騙って同様の攻撃。

検出のキモ:
- 著名ブランド名 (= 業務 / 個人で利用頻度高いもの top 100) を表示名に含むが、正規ドメインから来ていない
- 正規 brand logo を模した HTML 構造 (= MVP では画像解析しない、テキストヒューリスティックのみ)

### 1.3 ビジネスメール詐欺 (BEC、business email compromise)

取引先 / 役員 / CFO を装って金銭移動を誘導。最も金銭的損害が大きい。

検出のキモ:
- 表示名 = 既知連絡先と同名、送信ドメイン = 違う or lookalike
- 内容に「至急 wire transfer」「請求書添付」「銀行情報変更」等の金銭話題
- 過去にその表示名から金銭話題を受け取った履歴の有無 (= 行動 baseline)

### 1.4 詐欺 / スキャム (scam)

非標的型の金銭目的の欺き。advance-fee fraud、ロマンス詐欺、偽宅配通知、偽請求書。

### 1.5 スパム / 迷惑メール (spam)

不要だが攻撃意図はない大量配信。既存 curate の `unneeded` と重なるが、本書では「迷惑送信規制対象級」を明示的に分類。

### 1.6 マルウェア (malware) — Phase G6+

添付ファイル / リンク先がマルウェア配布。MVP スコープ外、Phase G6 以降。

---

## 2. 検出シグナル (= 多層構成)

LLM 単独判定の脆弱性 (= プロンプトインジェクション / 文脈混乱 / モデル更新で挙動変化) を避け、**6 層の signal を score 合算** する。LLM は層の 1 つに過ぎず、最終判定は重み付き和。

### 2.1 Layer 1: 認証ヘッダ (= SMTP 認証結果、protocol-agnostic)

| シグナル | 説明 | 強さ |
|---|---|---|
| **SPF fail** | 送信元 IP がドメインの正規送信者でない | 高 |
| **DKIM fail** | メール内容の改竄あり or 署名ドメイン不一致 | 高 |
| **DMARC fail** | SPF + DKIM が From ドメインと整合しない | 高 |
| **ARC fail** | 中継経路を通じた認証 chain が破綻 | 中 |
| **SPF/DKIM/DMARC none** | 認証情報が一切無い (= 認証されていないドメイン) | 中 |

**入手**:
- Gmail API: `Authentication-Results` ヘッダ
- IMAPS/POP3S: 同上 (= サーバ側でつけられたヘッダを fetch 時に取得)
- 自前 SMTP/MX 受信時 (= 将来): 受信時に OpenSPF / OpenDKIM ライブラリで検証

### 2.2 Layer 2: ヘッダ構造シグナル (= protocol-agnostic)

| シグナル | 説明 |
|---|---|
| **From 表示名 vs 送信ドメイン乖離** | "Apple Support <random@hotmail.com>" 型 |
| **From vs Reply-To ドメイン不一致** | 返信を別ドメインに誘導 |
| **List-Unsubscribe 不在 + 大量送信パターン** | 正規メルマガなら通常存在 |
| **Received chain の異常** | 中継経路に未知 / 国外サーバが混入 |
| **送信時刻 anomaly** | UTC 0:00 ぴったり等の自動化痕跡 |
| **Message-ID 形式異常** | RFC 5322 違反、再利用された ID |

実装: `src/lib/mail-header-signals.ts` (新規) でヘッダ parser + signal collector。

### 2.3 Layer 3: 送信者プロファイル (= 履歴 / 行動 baseline)

| シグナル | 検出方法 |
|---|---|
| **初見送信者** | `mail_messages WHERE from_email = ? AND id != current` の count |
| **同一表示名 × 複数異なるアドレス** | `GROUP BY from_name HAVING COUNT(DISTINCT from_email) > 1` |
| **lookalike ドメイン (= contacts 類似)** | contacts.email_domain と Damerau-Levenshtein < 3 |
| **lookalike ドメイン (= 過去信頼送信者類似)** | mail_messages の信頼送信者 vs 新着、edit distance |
| **連絡先未登録 + 重大話題** | `bucket = important` 候補だが contacts に無い |
| **過去にスパム / 脅威判定された同ドメイン** | `mail_messages WHERE from_domain = ? AND threat_level = 'dangerous'` |
| **送信頻度 anomaly** | 既知送信者なのに突然頻度が増加 (= アカウント乗っ取り疑い) |
| **時刻 anomaly** | 過去その送信者の送信時間帯と統計的に乖離 |

**「山田太郎」事例で最強の決定打になるシグナル** = 「同一表示名 × 複数異なるアドレス」。これは LLM 文脈推論より遥かに信頼できる (= 嘘をつけない硬いシグナル)。

実装: `src/lib/mail-sender-profile.ts` (新規) で履歴クエリ + 統計集計。

### 2.4 Layer 4: URL / 内容静的解析

#### 2.4.1 URL レベル

| シグナル | 検出方法 |
|---|---|
| **Punycode / IDN ホモグラフ** | URL に `xn--` prefix を含む、または Unicode confusable 検出 |
| **短縮 URL** | 既知短縮サービス domain list (bit.ly, t.co, ow.ly 等) |
| **link text vs href 乖離** | HTML parser で `<a>` を抽出、text と href のドメイン比較 |
| **HTTPS なし + フォーム誘導** | `http://` URL でフォーム入力誘導 |
| **既知悪質 TLD** | `.tk`, `.ml`, `.xyz` 等の cheap TLD (= 任意 list で settings 化) |
| **IP アドレス直接 URL** | `http://1.2.3.4/...` |
| **URL HEAD fetch + redirect chain** | `safeFetch` で HEAD のみ、最終ドメインまで追跡 |
| **WHOIS 登録日 30 日未満** | freshly registered domain (= 攻撃用 burner) |

実装: `src/lib/mail-url-analysis.ts` (新規、web container 側) で:
- HTML / plain text から URL 抽出
- 各 URL に対して `mail-security` コンテナの `/scan/url` endpoint を呼ぶ (= 詳細は `docs/file-security.md` §5)
- HEAD fetch / SSRF 防止 / WHOIS / 静的 flag 検出は `mail-security` 側で実施
- 結果を ThreatReason に変換して Layer 4 として集計

#### 2.4.2 内容レベル静的検出

| シグナル | 検出方法 |
|---|---|
| **QR コード送付要求 (キーワード)** | 正規表現: "QR コード", "LINE で連絡", "二次元コード" |
| **緊急性プレッシャー (キーワード)** | "24 時間以内", "至急", "停止", "凍結", "緊急" |
| **認証情報請求 (キーワード)** | "パスワード", "ワンタイムコード", "認証コード", "クレカ" |
| **添付ファイル危険型** | `.exe`, `.zip`, `.docm`, `.xlsm`, `.lnk` の存在 |

これらは LLM プロンプトより前段で **強い signal として扱う** (= 「LLM が見逃しても、ここで掴む」)。

### 2.5 Layer 5: 外部脅威インテリジェンス (= opt-in、無料 feed)

| feed | 利用形態 | プライバシー |
|---|---|---|
| **PhishTank** | 1 日 1 回 list download、ローカル URL 照合 | 完全ローカル、外部送信なし |
| **OpenPhish** | 同上 | 同上 |
| **Spamhaus DBL** | DNS query で 1 ドメインずつ照会 | DNS log には domain だけ残る (= 本文は出ない) |
| **SURBL** | 同上 | 同上 |
| **URLhaus** (= マルウェア URL) | list download | 完全ローカル |
| **Google Safe Browsing API** | URL を Google に送って照会 | **明示 opt-in**、Yui の設定で OFF がデフォルト |

実装: **`mail-security` コンテナの threat intel service** に委譲 (= `docs/file-security.md` §6 を正本)。

- feed download / cache / query は mail-security 側で完結
- web container 側は `src/lib/threat-intel-client.ts` (= 薄い HTTP client) で `/threat-intel/query` を呼ぶ
- mail-security 不在時は空配列を返す (= Layer 5 を実質無効化、他 layer で判定継続)

### 2.6 Layer 6: LLM 文脈推論 (= 最後の補完)

上記 Layer 1-5 で **強い決定打が無かった場合** に LLM を呼んで補完。LLM は:

- スプーフィングを暗黙的に検出 (= 「文体が普段の山田さんと違う」)
- 多言語フィッシング (= 英語 / 中国語) の検出
- 巧妙なソーシャルエンジニアリング (= 文脈に依存した非典型パターン)

ローカル LLM (Gemma 12B) 必須。プロンプトは §6 で定義。

LLM 出力は **score 0..1 + reasons** だけを受け取り、判定ロジックには使わない (= 他層と合算)。

### 2.7 多層判定の score 合算

各 layer から `(signal_kind, severity, weight, detail)` を集めて重み付き和:

```
threat_score = Σ (severity_value × weight)
  - Layer 1 (auth): severity high → 3.0, weight 1.0
  - Layer 2 (header): severity high → 2.5, weight 0.9
  - Layer 3 (profile): severity high → 4.0, weight 1.1  // 履歴は最強
  - Layer 4 (url/content): severity high → 2.5, weight 0.9
  - Layer 5 (threat intel): severity high → 5.0, weight 1.2  // 黒判定は超強い
  - Layer 6 (LLM): severity high → 2.0, weight 0.7  // 補完なので軽め

threat_level (= score → level):
  score >= 6.0   → "dangerous"
  score >= 3.0   → "suspicious"
  score <  3.0   → "safe"
```

数値は MVP のスタート値、Phase G3 で fixture テストでチューニング。

---

## 3. アーキテクチャ

### 3.1 全体パイプライン

```
[mail intake layer]  ← Gmail API / IMAPS / POP3S / 将来は SMTP 直受信
   │
   │  insert into mail_messages (= 標準スキーマ、protocol 非依存)
   ▼
[curate]            ← 既存 mail-curate.ts、important/needed/unneeded
   │
   ▼
[threat-audit]      ← 新規 mail-threat-audit.ts、6 層 signal collection + score 合算
   │
   ├─ Layer 1: parseAuthHeaders        (mail-header-signals.ts)
   ├─ Layer 2: parseStructuralHeaders  (同上)
   ├─ Layer 3: buildSenderProfile      (mail-sender-profile.ts)
   ├─ Layer 4: analyzeUrlsAndContent   (mail-url-analysis.ts)
   ├─ Layer 5: checkThreatIntel        (mail-threat-intel.ts)
   ├─ Layer 6: callLlmAudit            (Gemma 専用 prompt)
   ├─ aggregate score → level / type / reasons
   └─ write back to mail_messages
   │
   ▼
[dispatchNotification]
   level=dangerous    → kind="mail_threat" + severity high
   level=suspicious   → kind="mail_threat" + severity normal
   level=safe + curate → kind="mail_important" / "mail_other"
   │
   ▼
[quarantine workflow]
   level=dangerous かつ user 設定で auto_quarantine 有効
     → provider API で隔離 (Gmail label / IMAP move to Quarantine folder)
     → user UI からリリース可能
```

### 3.2 取り込み層の抽象化 (= protocol-agnostic)

> 詳細仕様は **`docs/mail-accounts.md` §3** を正本とする。本節は本書脅威検出側からの参照ポイントを記す要約。

`mail_messages` テーブルを **single source of truth** に。各 intake provider は以下のインターフェイスに従って row を insert:

```ts
interface MailIntakeAdapter {
  name: string;  // "gmail" | "imaps" | "pop3s" | ...
  poll(account: MailAccount): Promise<{
    inserted: number;
    fetched: number;
    blocked: number;
  }>;
  fetchBody(messageId: string): Promise<{ text: string; html?: string }>;
  setLabel?(messageId: string, label: string): Promise<void>;
  moveToFolder?(messageId: string, folder: string): Promise<void>;
  delete?(messageId: string): Promise<void>;
}
```

実装:
- `src/lib/mail-intake/gmail.ts` — 既存 mail-poll.ts のロジックをここに移す
- `src/lib/mail-intake/imaps.ts` — 新規、`imap` npm package or `nodejs-imap`
- `src/lib/mail-intake/pop3s.ts` — 新規、`node-pop3` 等
- `src/lib/mail-intake/index.ts` — adapter registry

threat-audit は **adapter を知らない**。`mail_messages` 行があれば動く。

### 3.3 隔離 (quarantine) 抽象化

各 adapter は `setLabel` / `moveToFolder` のうちサポートする方法を実装:
- Gmail: label `Phishing` を付ける (= 削除はしない、user が確認可能)
- IMAPS: `Quarantine` フォルダを作って move
- POP3S: 削除はできるが復元できない → POP3S アカウントは隔離アクション無効、通知のみ

ユーザは UI から:
- 「これはフィッシングです」(= 承認、移動を確定 + 学習例として保存)
- 「これは正規です」(= 解放、元のフォルダに戻す + 学習例として false positive 修正)

実装: `src/lib/mail-quarantine.ts` (新規)

### 3.4 通知 EventKind 拡張

`docs/notification-system.md` に `mail_threat` を追加 (= notification-system v2 §10.4 拡張):

```ts
export type EventKind =
  | "morning_brief"
  | "diary"
  | "news"
  | "mail_important"
  | "mail_other"
  | "mail_threat"  // ← 新規
  | "music"
  | "schedule"
  | "health"
  | "reminder";
```

DEFAULT_RULES:

```ts
{
  eventKind: "mail_threat",
  toastOnline: true, speakOnline: true,
  toastAway:   true, speakAway:   true,   // 離席中でも知りたい
  toastFocus:  true, speakFocus:  true,   // 集中中でもセキュリティ最優先
  discordPolicy: "always",                // 常時 Discord 通知
  importance: "high",
},
```

---

## 4. データモデル

### 4.1 migration 0068: threat columns

```sql
-- mail_messages: threat columns
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS threat_level TEXT;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS threat_type TEXT;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS threat_score REAL;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS threat_reasons JSONB;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS threat_audited_at TIMESTAMPTZ;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS quarantined_at TIMESTAMPTZ;
ALTER TABLE mail_messages ADD COLUMN IF NOT EXISTS quarantine_released_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_mail_threat_level
  ON mail_messages (threat_level, received_at DESC)
  WHERE threat_level IN ('suspicious', 'dangerous');
```

列定義:

| 列 | 値域 | 説明 |
|---|---|---|
| `threat_level` | `safe \| suspicious \| dangerous` | 最終判定 |
| `threat_type` | `phishing \| brand_impersonation \| bec \| scam \| spam \| malware \| null` | 詳細カテゴリ |
| `threat_score` | REAL 0..10 | 加重和 score (= §2.7) |
| `threat_reasons` | JSONB `Array<ThreatReason>` | 各層から拾った red flag リスト |
| `threat_audited_at` | TIMESTAMPTZ | 監査時刻 (= 再監査トリガに使う) |
| `quarantined_at` | TIMESTAMPTZ | 隔離した時刻 |
| `quarantine_released_at` | TIMESTAMPTZ | user リリース時刻 |

### 4.2 migration 0069 / 0070: intake adapter generalization

**正本は [`docs/mail-accounts.md`](mail-accounts.md) §4 を参照** (= 重複定義を避けるため本書には書かない)。

要旨:
- **0069**: `mail_messages` に `intake_adapter` / `external_message_id` / `external_thread_id` 列追加 + 既存 gmail_* 列から自動 UPDATE。新 unique key は `(intake_adapter, account_id, external_message_id)`
- **0070**: `gmail_accounts` → `mail_accounts` rename + IMAPS/POP3S 用列 + `encrypted_password` (= AES-256-GCM) + 接続テスト結果列

本書 (threat detection) は migration 適用後の **`mail_accounts` / `mail_messages`** に対して動作する。詳細スキーマと SQL は mail-accounts.md §4 が single source of truth。

### 4.4 migration 0071: threat intel cache tables

```sql
-- PhishTank / OpenPhish / URLhaus 等の URL list ローカルキャッシュ
CREATE TABLE IF NOT EXISTS threat_intel_url_cache (
  url_hash    BYTEA PRIMARY KEY,  -- SHA-256 of normalized URL
  feed_source TEXT NOT NULL,      -- 'phishtank' | 'openphish' | 'urlhaus'
  threat_type TEXT NOT NULL,      -- 'phishing' | 'malware' | 'scam'
  added_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_threat_intel_url_cache_expires
  ON threat_intel_url_cache (expires_at);

-- feed 取得状態
CREATE TABLE IF NOT EXISTS threat_intel_feed_status (
  feed_source     TEXT PRIMARY KEY,
  last_fetched_at TIMESTAMPTZ,
  last_count      INTEGER,
  last_error      TEXT
);
```

### 4.5 ThreatReason 構造

```ts
type ThreatReason = {
  layer: 1 | 2 | 3 | 4 | 5 | 6;  // どの層から
  kind: ThreatReasonKind;        // 詳細種別 (= 列挙)
  severity: "high" | "medium" | "low";
  weight: number;                // 重み (= layer 既定 + 個別調整)
  detail: string;                // 短い具体例 (50 字以内、PII 除外)
};

type ThreatReasonKind =
  // Layer 1: auth
  | "spf_fail" | "dkim_fail" | "dmarc_fail" | "arc_fail" | "auth_none"
  // Layer 2: header
  | "display_domain_mismatch" | "replyto_mismatch" | "no_unsubscribe"
  | "received_chain_anomaly" | "time_anomaly" | "msgid_anomaly"
  // Layer 3: profile
  | "new_sender" | "spoofing_history" | "lookalike_contact_domain"
  | "lookalike_trusted_domain" | "first_contact_important"
  | "domain_prior_threat" | "frequency_anomaly"
  // Layer 4: url/content
  | "url_punycode" | "url_shortener" | "url_text_mismatch" | "url_no_https"
  | "url_bad_tld" | "url_ip_direct" | "url_redirect_chain"
  | "domain_recently_registered" | "qr_code_request" | "credential_request"
  | "urgency_pressure" | "dangerous_attachment"
  // Layer 5: threat intel
  | "phishtank_hit" | "openphish_hit" | "urlhaus_hit"
  | "spamhaus_dbl_hit" | "surbl_hit" | "gsb_hit"
  // Layer 6: llm
  | "llm_pattern_match" | "llm_style_anomaly"
  // misc
  | "other";
```

UI 表示用ラベルは `src/lib/mail-threat-labels.ts` (新規) に集約。

---

## 5. lib モジュール構成

```
src/lib/                          ← web container 側 (Yui 本体)
├── mail-intake/                  ← 取り込み adapter (= 詳細は docs/mail-accounts.md)
│   ├── index.ts                  ← adapter registry
│   ├── gmail.ts                  ← 既存 mail-poll.ts のロジック移管
│   ├── imaps.ts                  ← 新規
│   └── pop3s.ts                  ← 新規
├── mail-threat-audit.ts          ← entry: auditMail / auditMails
├── mail-header-signals.ts        ← Layer 1-2 (= web 側 header parser)
├── mail-sender-profile.ts        ← Layer 3 (= web 側、DB 履歴クエリ)
├── mail-url-analysis.ts          ← Layer 4 client (= mail-security/scan/url を呼ぶ)
├── threat-intel-client.ts        ← Layer 5 client (= mail-security/threat-intel/query を呼ぶ)
├── file-scanner.ts               ← 添付スキャン client (= mail-security/scan/file を呼ぶ)
├── mail-llm-audit.ts             ← Layer 6 (= ローカル Gemma 呼び出し)
├── mail-threat-aggregate.ts      ← 6 層 → score 合算 → threat_level
├── mail-quarantine.ts            ← 隔離 / リリース (= adapter 経由)
├── mail-threat-labels.ts         ← ThreatReason → UI ラベル
└── mail-curate.ts                ← 既存、無変更

mail-security/                    ← 専用コンテナ側 (= docs/file-security.md 参照)
├── src/services/
│   ├── clamav.ts                 ← 添付ウィルススキャン
│   ├── url-analysis.ts           ← Layer 4 本体 (= HEAD fetch + redirect + SSRF 防止)
│   ├── feed-fetcher.ts           ← threat intel feed daily download
│   └── threat-intel.ts           ← Layer 5 本体 (= URL 照合 cache)
└── ...
```

**責務分担**:
- **web 側 lib**: 履歴クエリ (Layer 3) と LLM (Layer 6)、score 合算、UI 連携。重い処理は持たない
- **mail-security 側**: ClamAV / URL HEAD / threat intel cache / 外向き HTTP (= 攻撃面)、SSRF 防止 / ネットワーク isolation

### 5.1 公開 API

```ts
// mail-threat-audit.ts
export type ThreatAuditResult = {
  level: "safe" | "suspicious" | "dangerous";
  type: ThreatType | null;
  score: number;          // 0..10
  reasons: ThreatReason[];
};

export async function auditMail(mailId: number): Promise<ThreatAuditResult>;
export async function auditMails(mailIds: number[]): Promise<Map<number, ThreatAuditResult>>;

// mail-threat-intel.ts
export async function refreshThreatIntel(): Promise<{ updated: number }>;  // periodic trigger (= interval) で呼ぶ
export async function queryUrl(url: string): Promise<ThreatIntelHit[]>;

// mail-quarantine.ts
export async function quarantineMail(mailId: number): Promise<void>;
export async function releaseFromQuarantine(mailId: number): Promise<void>;
```

---

## 6. LLM プロンプト (= Layer 6)

LLM は補完 layer なので、プロンプトを軽量化して以下に集中させる:

- 文体 / 文章スタイルの違和感 (= 「いつもの山田さんなら使わない言い回し」)
- 多言語フィッシング (= 英語 / 中国語混入)
- 巧妙なソーシャルエンジニアリング (= 静的 signal で拾えないもの)
- ブランドなりすましの context 確認 (= 「Apple を騙る文章だが正規 Apple ではない」)

SYSTEM_PROMPT:

```text
あなたはご主人様のメールセキュリティ監査員 (= 多層検出システムの最終補完層) です。

事前に collected された以下のシグナルが context として与えられます:
  Layer 1: 認証ヘッダ (SPF/DKIM/DMARC)
  Layer 2: ヘッダ構造 (display name 乖離 等)
  Layer 3: 送信者プロファイル (履歴、lookalike 等)
  Layer 4: URL / 内容静的解析
  Layer 5: 脅威インテリ照合結果

あなたの仕事は:
1. これら静的層が **見落としている文脈レベルのリスク** を補完検出する
2. 文体 / 文章スタイルが既知送信者と乖離していないか
3. 多言語混入 (= 主言語と異なる lang の混入)
4. 巧妙なソーシャルエンジニアリング (= 「至急」「停止」等の静的ワード以外の心理操作)
5. ブランドなりすまし (= 既知ブランド名を使うが文脈が正規でない)

注意:
- あなたは **判定主体ではない**。あなたの出力は score として他層と合算される。
- 静的層が「dangerous」を強く示しているなら、あなたが「safe」と言っても上書きできない。
- 確信が無い場合は score を低く (= 0.0〜0.3) で返し、reason に "uncertain" を記す。

出力 JSON (1 行のみ):
{
  "score": 0.0〜1.0,    // この LLM 層単独でのリスク評価
  "type_hint": "phishing|brand_impersonation|bec|scam|spam|null",
  "reasons": [
    {"kind": "llm_pattern_match|llm_style_anomaly|other",
     "severity": "high|medium|low",
     "detail": "短い具体例"}
  ]
}
```

user-prompt template:

```text
[他層のシグナル要約]
{layer1-5 summary}

[件名]
{subject}

[本文先頭 800 字]
{body_head}

[送信者情報]
表示名: {name}
アドレス: {email}
過去の同表示名からの受信履歴: {count, with details}

[判定]
```

---

## 7. mail-poll (取り込み) 統合

### 7.1 既存 mail-poll.ts の変更

Phase G1 (= MVP) では現状の Gmail-only 構造を保ったまま、curate の後に auditMails を呼ぶだけにする:

```ts
// mail-poll.ts (Phase G1 後)
await curateMails(allInsertedIds);

// 新規: threat audit
const threatResults = await auditMails(allInsertedIds);

// dispatch with threat-aware kind
for (const m of passingRows) {
  const threat = threatResults.get(m.id);
  // ... §3.1 の判定で kind を決定 ...
}

// 隔離 (auto_quarantine 設定が有効、かつ dangerous の場合のみ)
const settings = await getMailThreatSettings();
if (settings.auto_quarantine_threshold) {
  for (const [mailId, t] of threatResults) {
    if (t.level === "dangerous" && t.score >= settings.auto_quarantine_threshold) {
      await quarantineMail(mailId);
    }
  }
}
```

### 7.2 multi-provider intake との接続 (= mail-accounts.md Phase H 完了後)

intake adapter 化 / orchestrator 化 / IMAPS/POP3S 実装は [`docs/mail-accounts.md`](mail-accounts.md) §3.4 を正本とする。本書側は **adapter-aware な threat-audit / quarantine** の追加配線のみを担当 (= §13.5 Phase G5 参照):

- orchestrator (= mail-accounts.md Phase H 完成形) は curate → threat-audit → dispatch を adapter 非依存に共通呼び出しする設計なので、threat-audit 側は **何の追加変更も無い** (= mail_id を受け取って動くだけ)
- 唯一 adapter を意識する箇所は **隔離アクション** (= dangerous 検出時の自動 quarantine)。mail-accounts.md §3.3 quarantine 抽象化に従い、Gmail なら label / IMAPS なら folder move / POP3S なら不可、を adapter 別に分岐する

---

## 8. 通知連携

### 8.1 EventKind `mail_threat`

§3.4 参照。DEFAULT_RULES で常時 toast + speak + Discord push、importance high。

### 8.2 toast UI

NotificationToast.tsx に case 追加:

```tsx
case "mail_threat":
  return (
    <svg {...common} style={{ color: "#d33" }}>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <polyline points="3 9 12 15 21 9" />
      <path d="M12 11v3M12 17v.5" />
      <circle cx="12" cy="14" r="6" stroke="#d33" strokeWidth="1.5" fill="none" />
    </svg>
  );
```

CSS:

```css
.notification-toast[data-kind="mail_threat"] {
  border-color: #d33;
  background: linear-gradient(180deg, rgba(255, 70, 70, 0.05), rgba(255, 255, 255, 1));
}
```

### 8.3 ReportPanel での詳細表示

bodyMd は以下のフォーマット:

```markdown
## ⚠ 脅威検出: {件名}

**判定**: {level} ({type}) / 確信度 {score}/10
**送信者**: {表示名} <{email}>
**監査時刻**: {timestamp}

### 主要危険信号 (severity 高い順、最大 5 件)

- 🔴 [Layer 3] **{kind ラベル}**: {detail}
- 🔴 [Layer 5] **{kind ラベル}**: {detail}
- 🟡 [Layer 1] **{kind ラベル}**: {detail}
...

### 推奨対応

1. 即座に返信しない
2. メール内のリンク / 添付ファイルを開かない
3. 実在する組織なら **公式ルート** (= サイト直接アクセス / 既知の電話番号) で確認
4. 必要なら隔離: [Phishing として隔離] [このメールを削除]
5. もし正規メールだった場合: [正規としてマーク (= 学習に反映)]
```

---

## 9. UI 配置

### 9.1 SettingsModal「メール」タブにサブタブ「脅威検出」追加

```
┌─ メール ────────────────────────────────────────────────┐
│ [仕分け学習例] [脅威検出] [取り込み設定]   ← サブタブ      │
├─────────────────────────────────────────────────────────┤
│ ☑ メールの脅威を自動監査する (= 多層検出を有効化)         │
│                                                          │
│ 感度: [medium ▾]   - 通常 6.0 で dangerous、3.0 で suspicious │
│ 自動隔離 score 閾値: [8.0 ▾]   - これ以上で provider に隔離 │
│                                                          │
│ ─── 検出層別有効化 ───                                    │
│ ☑ Layer 1: 認証ヘッダ (SPF/DKIM/DMARC)                    │
│ ☑ Layer 2: ヘッダ構造                                    │
│ ☑ Layer 3: 送信者プロファイル                            │
│ ☑ Layer 4: URL / 内容静的解析                             │
│ ☑ Layer 5: 脅威インテリ                                  │
│   ☑ PhishTank (= 完全ローカル)                            │
│   ☑ OpenPhish (= 完全ローカル)                            │
│   ☑ Spamhaus DBL (= DNS 照会、domain だけ外部送信)       │
│   ☐ Google Safe Browsing (= URL を Google に送信、要 opt-in)│
│ ☑ Layer 6: LLM (= ローカル Gemma)                         │
│                                                          │
│ ─── 既知信頼送信者 (= lookalike 検出の基準) ───           │
│ ご主人様の contacts と過去 6 ヶ月で頻度の高い送信者を     │
│ 自動的に「信頼」として扱います。手動追加も可:              │
│   [+ 信頼送信者を追加]                                    │
│                                                          │
│ ─── 隔離フォルダ ─── (IMAPS / POP3S 用)                  │
│ ☑ provider のフォルダに移動する: [Quarantine ▾]           │
│ ☐ Gmail はラベルのみ (= 削除しない、user 確認待ち)       │
└─────────────────────────────────────────────────────────┘
```

### 9.2 メール一覧 UI (= 既存 MailModal 拡張)

メール行に threat バッジ:

```
[メール (重要)] [⚠ dangerous]  件名
                                送信者 / 時刻 / preview
```

フィルタ: `安全のみ / suspicious 以上 / dangerous のみ / 隔離中`。

### 9.3 隔離 LogModal タブ

LogModal に「隔離」タブ追加:

```
┌──────────────────────────────────────────────────────────┐
│ ログ                                                ×    │
├──────────────────────────────────────────────────────────┤
│ [会話] [システム] [お便り] [隔離]                          │
├──────────────────────────────────────────────────────────┤
│ 6/8 21:48  ⚠ dangerous  山田太郎 名義のフィッシング 3 件 │
│            [リリース] [永久削除] [理由を見る]              │
│ 6/7 14:30  ⚠ suspicious  Apple サポート (偽物)           │
│            [リリース] [永久削除] [理由を見る]              │
│ ...                                                       │
└──────────────────────────────────────────────────────────┘
```

---

## 10. 設定 (= mail_curation_settings 拡張 or 新 mail_threat_settings)

意味的に分けたいので **`mail_threat_settings` 新規テーブル** を作る:

```sql
CREATE TABLE IF NOT EXISTS mail_threat_settings (
  id                          SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled                     BOOLEAN      NOT NULL DEFAULT TRUE,
  sensitivity                 TEXT         NOT NULL DEFAULT 'medium',   -- 'low'|'medium'|'high'
  auto_quarantine_threshold   REAL,        -- NULL なら自動隔離無効
  layer1_enabled              BOOLEAN      NOT NULL DEFAULT TRUE,
  layer2_enabled              BOOLEAN      NOT NULL DEFAULT TRUE,
  layer3_enabled              BOOLEAN      NOT NULL DEFAULT TRUE,
  layer4_enabled              BOOLEAN      NOT NULL DEFAULT TRUE,
  layer5_enabled              BOOLEAN      NOT NULL DEFAULT TRUE,
  layer5_feeds                JSONB        NOT NULL DEFAULT '["phishtank","openphish"]',
  layer6_enabled              BOOLEAN      NOT NULL DEFAULT TRUE,
  quarantine_folder           TEXT         NOT NULL DEFAULT 'Quarantine',
  updated_at                  TIMESTAMPTZ  NOT NULL DEFAULT now()
);

INSERT INTO mail_threat_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
```

migration 0072。

---

## 11. API

```
GET    /api/mail/threats?level=dangerous&limit=20
  脅威検出されたメール一覧

POST   /api/mail/threats/<mail_id>/feedback
  body: { verdict: "phishing" | "safe" | "uncertain", reason?: string }
  user 訂正 → 学習例 + score 重み再調整候補

POST   /api/mail/threats/<mail_id>/reaudit
  単体メールの再監査

POST   /api/mail/threats/<mail_id>/quarantine
  手動隔離

POST   /api/mail/threats/<mail_id>/release
  隔離からリリース

GET    /api/mail/threat-settings
PATCH  /api/mail/threat-settings
  ↑ §10 のテーブル内容を CRUD

POST   /api/mail/threat-intel/refresh
  feed を強制 refresh (= 通常は periodic trigger で 24h 毎、intervalMs ベース)
```

---

## 12. プライバシー / セキュリティ

- **本文 / リンク先 URL を外部 LLM に絶対送らない**: Layer 6 は必ずローカル LLM 経由
- **threat_reasons の detail に PII 含めない**: 文字列断片 / 個人名は除外、汎化された理由のみ
- **Google Safe Browsing は opt-in**: URL を Google に送るため、デフォルト OFF。設定で明示有効化必須
- **threat intel feed のローカル化**: PhishTank / OpenPhish / URLhaus は完全ローカル照合 (= URL を外部送信しない)
- **Spamhaus DBL** は DNS 照会なので **domain だけ外部に出る** (= 本文は出ない)。ご主人様への明示が必要
- **IMAP/POP3 パスワードは AES-256-GCM 暗号化** (= 既存 `src/lib/crypto.ts` 流用)
- **ログ出力**: console / debug に本文 / 全 URL を出さない、`mail_id` のみで identify
- **学習例の蓄積**: feedback API で本文を training data 化する場合、ご主人様の明示同意 + 暗号化保存 (= Phase G3 で詳細議論)

---

## 13. 段階的実装

### Phase G1 (= MVP、半日)

- migration 0068 (= threat_* 列)
- schema.ts 反映
- `mail-threat-audit.ts` 新規 (= Layer 1, 2, 3, 6 最小実装)
- Layer 4 / 5 はスタブ (= 全て score 0 を返す。本実装は §13.2 / §13.3)
- mail-poll.ts: curate 後に auditMails 呼び出し
- dispatchNotification の kind 判定に threat 組み込み
- **§13.1 (G1 差分一覧)** の他 file への変更を全て適用

**完了条件**: 「山田太郎」事例 (= スプーフィング履歴) が Layer 3 で検出されて dangerous 判定される

#### 13.1 G1 で他 file に適用する差分一覧

本書の Phase G1 で `mail_threat` を導入するため、以下の file に変更を入れる (= notification-system.md は記載上「拡張予定」のみだが、実装は本書で完結):

| 対象 file | 変更内容 |
|---|---|
| `src/lib/notification-settings.ts` | `EventKind` union に `"mail_threat"` 追加 |
| `src/lib/notification-settings.ts` | `DEFAULT_RULES` に `mail_threat` 行追加 (= 本書 §3.4 で定義したルールセット、全 state toast+speak、Discord always、importance high) |
| `src/app/api/notification-settings/[kind]/route.ts` | `VALID_KIND` Set に `"mail_threat"` 追加 |
| `src/components/NotificationsSection.tsx` | `KIND_LABEL` に `mail_threat: "フィッシング / 脅威警告"` 追加 |
| `src/components/NotificationToast.tsx` | `KindIcon` switch に `case "mail_threat"` 追加 (= 本書 §8.2 の SVG)、CSS に `.notification-toast[data-kind="mail_threat"]` の赤系 border (= 本書 §8.2 の CSS) |
| `docs/notification-system.md` | §10.4 / §3 マトリックス表に `mail_threat` 行を追記 (= 本書 §3.4 の DEFAULT_RULES を反映、コメントで「mail-threat-detection.md 由来」と注記) |

これで G1 完了時点で、UI / API / migration / dispatch 全てが mail_threat に対応する。notification-system.md 側の更新はドキュメント整合性確保のためで、コードへの影響は無い。

### Phase G2 (= 1 日、Layer 1/2/4 client integration)

- **`docs/file-security.md` Phase S2 (= `/scan/url` endpoint) 完了が前提**
- S2 完了前: Layer 4 は client fallback (= `analyzeUrl` 呼び出すが mail-security 不在で `{ error, flags: {} }` を受けて Layer 4 score 0 になる) で安全に動作
- S2 完了後: `src/lib/mail-url-analysis.ts` (web 側 client) で `/scan/url` を呼ぶ実装に切り替え、Layer 4 を score 合算に組み込み
- Gmail metadata 取得 header 追加 (= Authentication-Results / Reply-To / List-Unsubscribe)
- Layer 1, 2 を完全実装 (= ヘッダ parser、web 側のみで完結)
- SettingsModal「メール > 脅威検出」サブタブ追加
- LLM プロンプトを最終形に
- fixture 10-20 件で chunk テスト + チューニング

### Phase G3 (= 2-3 日、Layer 5 統合)

- **`docs/file-security.md` Phase S3 (= feed loader + periodic interval refresh + cache) 完了が前提**
- S3 完了前: Layer 5 は client fallback (= `queryThreatIntel` は空配列を返す、score 0) で安全に動作
- S3 完了後: `src/lib/threat-intel-client.ts` (web 側) で mail-security の `/threat-intel/query` を呼ぶ実装に切り替え、Layer 5 を score 合算に組み込み
- migration 0072 (= mail_threat_settings)
- ブランド名リスト (= 著名 100 ブランド) を hardcode 化、Layer 4 で使う
- lookalike domain (Damerau-Levenshtein) を Layer 3 で実装
- `/api/mail/threats/feedback` + UI 訂正導線

### Phase G4 (= 1 週間)

- ML ensemble (= 局所学習、scikit-learn 級の軽量モデル、別 Python service 検討)
- per-user baseline (= 受信履歴ベースの anomaly)
- 隔離フロー (= mail-accounts.md §5.x の adapter 経由) 実装
- `mail-quarantine.ts` 実装、UI 「隔離」タブ
- 統計ダッシュボード (= 過去 30 日 threat 件数推移)

### Phase G5 (= `docs/mail-accounts.md` Phase H1-H4 完了が前提)

intake adapter / IMAPS / POP3S / 設定 UI の実装は **mail-accounts.md Phase H1-H4** が正本。本書側で行う作業:

- mail-accounts.md Phase H1-H4 完了後、本書の `mail-threat-audit` / `mail-quarantine` を adapter-aware に拡張
- 隔離アクション (= dangerous 検出時の自動隔離) を adapter 別に分岐 (= mail-accounts.md §3.3 quarantine 抽象化を経由)
  - Gmail → label "Phishing"
  - IMAPS → `Quarantine` フォルダへ move
  - POP3S → 隔離不可、通知のみ (= UI で明示警告)
- multi-provider 環境での per-account 監査結果集計 (= 統計ダッシュボード extension)

本 Phase は **新規実装をほぼ含まず**、上位 H 系の完成を待って integration を行う position。

### Phase G6 (= 将来、別 doc に分割移管)

以下は **`docs/file-security.md`** に分割移管:

- 添付ファイルウィルススキャン (= ClamAV、Phase S1)
- URL HEAD 解析 + SSRF 防止 (= Phase S2)
- threat intel feed (PhishTank / OpenPhish / URLhaus / DBL / GSB) の統合 (= Phase S3-S4)
- 添付 sandbox (Cuckoo / Firejail / 自前 VM、= Phase S5)
- 画像 ML / brand logo 検出 (= Phase S5)

本書の Layer 4 / Layer 5 / 添付スキャン は **`mail-security` コンテナへの internal HTTP call** で実装される。詳細は file-security.md を参照。

その他、本書独自の将来項目:

- ML モデルの継続学習 (= user feedback → 再訓練 pipeline、Phase G4 で着手予定だが詳細は別途)
- SMTP/MX 直受信 (= postfix + Yui ゲートウェイ、要セキュリティ大幅レビュー)
- BIMI / DMARC レポート集計
- 多 provider 化された intake からの一貫した監査 (= mail-accounts.md と統合)

---

## 14. テスト観点

### 14.1 機能テスト

- [ ] migration 0068 適用後、threat_* 列が NULL で存在
- [ ] mail-poll で新着 → auditMails が呼ばれ、threat_audited_at が立つ
- [ ] ローカル LLM 無効状態だと Layer 6 skip + warn、他層は動く
- [ ] 「山田太郎」スプーフィング fixture (= 同名異アドレス 3 件) → Layer 3 で `spoofing_history` 検出
- [ ] Apple ブランドなりすまし fixture → Layer 3/4 で `lookalike_*` + `brand_impersonation`
- [ ] PhishTank URL を含む fixture → Layer 5 で `phishtank_hit`
- [ ] 正規請求書 fixture → safe
- [ ] フォルス陽性率 < 5%、検出率 > 90% を fixture 50 件で確認
- [ ] dispatchNotification の kind=`mail_threat` 配信
- [ ] 集中モードでも `mail_threat` の toast + speak が出る
- [ ] 自動隔離が threshold 超で発動、Gmail label が付く
- [ ] リリース UI が動作、quarantine_released_at が立つ

### 14.2 セキュリティテスト

- [ ] IMAP/POP3 パスワードが平文で DB に残らない (= encrypted_password 列が暗号化済み)
- [ ] ログに本文断片が出ない
- [ ] Google Safe Browsing が opt-out 時に絶対呼ばれない
- [ ] safeFetch 経由で SSRF が防げる (= 内部 IP に redirect されても遮断)
- [ ] LLM プロンプトインジェクション耐性 (= 本文に "ignore prior instructions" 入れても判定が壊れない)

### 14.3 パフォーマンステスト

- [ ] 1 通あたり全 layer 監査が < 3 秒 (= ローカル LLM 含む)
- [ ] 100 通並列でも DB / Valkey に過負荷無し
- [ ] threat_intel cache の照合が < 10 ms / URL

### 14.4 fixture

`tests/fixtures/mail-threat/` に分類:
- `phishing/` (= 典型フィッシング 20 件)
- `brand-impersonation/` (= 著名ブランドなりすまし 10 件)
- `bec/` (= BEC 5 件)
- `scam/` (= ロマンス / 投資詐欺 5 件)
- `spam/` (= 大量配信 10 件)
- `safe-legit/` (= 正規メール 30 件、false positive 検証用)

各 fixture は EML 形式 (= RFC 5322 準拠) で保存、適当な sanitizer (= 個人名差し替え) を通したもの。

---

## 15. 後方互換性と移行

| 変更 | 旧データへの影響 | 対応 |
|---|---|---|
| migration 0068 (threat_*) | 既存行は threat_level=NULL | UI で「未監査」表示、バックフィル script で過去メールを一括処理 |
| migration 0069 / 0070 (intake adapter) | mail-accounts.md §4 が正本 | 本書 scope 外 |
| migration 0071 (threat_intel cache) | 新規テーブル | 影響なし、本書管理 |
| migration 0072 (mail_threat_settings) | 新規テーブル | 影響なし、本書管理 |
| EventKind `mail_threat` 追加 | DEFAULT_RULES 自動補完 | notification-system v2 と同パターン (= §13.1 の他 file 差分一覧) |
| バックフィル | 過去 90 日分を G2 以降で一括監査可 | `npm run mail:backfill-threat` |

ロールバック (本書管理範囲):
- **G1** → migration 0068 を down (= threat_* 列 drop) で v1 に戻る + §13.1 で他 file に入れた diff を revert
- **G2** → mail-url-analysis.ts (web 側 client) を no-op スタブに戻す (= Layer 4 score 0)、mail-security 側の S2 はそのまま放置で可
- **G3** → threat-intel-client.ts を no-op (= Layer 5 score 0) + migration 0072 を down
- **G5** → adapter-aware quarantine ロジックを共通実装に戻す。intake adapter 自体 (= mail-accounts.md Phase H) のロールバックは本書 scope 外

---

## 16. 既知の限界

- **添付マルウェア検出不可** (= sandbox 無し、Phase G6 で別途議論)
- **画像ベースなりすまし不可** (= 画像 ML 必要、G6)
- **零日フィッシング** (= 既知パターンに無いもの) は Layer 3 履歴 + Layer 6 LLM で部分カバーが限界
- **多言語の精度** (= ローカル Gemma の日本語強化版 vs 英中等) は Phase G4 で要評価
- **ご主人様自身が騙されるパターン** (= 既知連絡先からの正規アドレスでの悪意ある依頼) は仕組み的に検出不可、教育で対処
- **メール本文と添付の暗号化** (= S/MIME) は復号できないと内容解析不可、ヘッダ層のみ判定

---

## 17. 将来拡張余地

- BIMI / DMARC レポート集計
- LLM 個人化 (= ご主人様の文体 fingerprint を学習、知人のなりすまし検出に活用)
- thread continuity 高度化 (= スレッド内の人物入れ替わり / トーン変化検出)
- 音声 deepfake への対応 (= 添付音声の真偽判定、将来)
- メール意図の説明可能化 (= 「なぜ Yui が dangerous と判定したか」をご主人様に自然言語で説明する LLM 経路)
- 関係者ごとの個別 baseline (= 「山田さんはこういう書き方をする」を学習)
- shared phishing pattern community (= 他 Yui インスタンスと暗号化 pattern を共有、opt-in)

---

## 18. コミット規約

`CLAUDE.md` 規約に従う:
- 新規 migration は `IF NOT EXISTS` で idempotent
- API route の catch は `clientError()`
- 新規依存 (= `imap`, `node-pop3`, `whois`, `psl` 等) は理由説明 + lockfile commit + npm audit
- Commit message は `Phase G1: mail threat detection — ...` のように Phase 番号 prefix

---

## 19. 監査スクリプト (= セルフチェック)

```bash
# auditMails が呼ばれていない mail 挿入経路を検出
grep -rn "db.insert(mailMessages)" src --include="*.ts" \
  | grep -v "src/lib/mail-intake/\|src/periodic/mail-poll.ts"
# → 出力ゼロを期待

# mail_threat_audit role がローカル LLM 必須に登録されているか
grep -n "mail_threat_audit" src/lib/llm.ts src/lib/ai-settings.ts
# → 両方に登録されていること

# 本文を外部 LLM に渡していないか (= Anthropic/OpenAI フォールバック禁止)
grep -rn "callLlm.*mail_threat_audit\|callLlm.*mail_curate" src/lib --include="*.ts"
# → fallbackProvider が無いことを確認
```
