# Security Policy

Yui Agent のセキュリティに関する報告 / 脆弱性開示の窓口です。

---

## サポート対象バージョン

本プロジェクトは個人運用前提のため、**最新の `main` ブランチのみ**をサポート対象とします。古い tag / commit に対する個別のセキュリティ修正は提供しません。

| バージョン | サポート |
|---|---|
| `main` (= 最新) | ✅ |
| それ以前 | ❌ |

セキュリティ修正を反映するには、`git pull` で main を最新に更新してください。

---

## 脆弱性の報告方法

### 1. GitHub の Private Vulnerability Reporting (推奨)

最も安全な経路です。一般公開せずに maintainer と直接やり取りできます。

1. 本リポジトリの **Security タブ** を開く
2. **Report a vulnerability** をクリック
3. 詳細を記入して送信

### 2. GitHub Issue (= 公開で構わない、または推奨経路が使えない場合のみ)

公開 issue にする場合は、**まだ exploit 可能な未公表脆弱性は書かないでください**。「設計上の懸念」「ベストプラクティス違反」など、公開しても直ちに悪用されない内容に限ります。

### 含めてほしい情報

- **影響範囲** (= どの機能 / どのエンドポイントが影響を受けるか)
- **再現手順** (= 可能な限り PoC レベルで具体的に)
- **想定される攻撃シナリオ** (= 何ができるか、誰に被害が出るか)
- **検出した環境** (= OS / Docker version / コミット hash)
- **CVSS スコアの目安** (= 任意、付けられたら助かります)

---

## レスポンス目安 (= ソロ運用の現実)

| フェーズ | 目安 |
|---|---|
| 一次返信 (= 受領確認) | 3-7 日 |
| 影響範囲の評価 | 1-2 週間 |
| 修正 PR | 重大度に応じて 1-4 週間 |
| 公開ディスクロージャ | 修正リリース後 14 日 |

**重大度 Critical (= 認証バイパス / RCE 等) の場合は最優先で対応します**。ただしソロ個人運用の制約上、商用 OSS プロジェクトのような 24h 対応はできません。

---

## 想定する脅威モデル (= スコープ内)

本プロジェクトは「個人ユーザが自宅 / Tailscale 内 / 信頼できる VPS で動かす単一ユーザアプリ」として設計されています。以下はスコープ内のセキュリティ事項です:

### スコープ内 (= 報告歓迎)

- **認証バイパス** (= AUTH_TOKEN を持たずに `/api/*` や保護ページに到達できる)
- **SSRF** (= `web_fetch` 系 tool / news source / TTS / Embeddings URL 経由で内部ネットワークに到達)
- **OAuth トークンの平文漏洩** (= DB dump で Google / Spotify token が平文で取れる)
- **Gmail ヘッダインジェクション / 任意 send 経路**
- **XSS / メール HTML** (= 受信メール HTML をモーダルで開く経路)
- **Prompt injection** (= timer の `onFirePrompt` や mail 学習例経由で高権限 tool が呼ばれる)
- **アップロード経路の検証不足** (= VRM / BGM の magic byte / cleanup 漏れ)
- **例外メッセージ漏洩** (= 上流 API レスポンスや DB ドライバ詳細が client に出る)
- **依存パッケージの既知脆弱性** (= `npm audit` 報告レベル中以上)

### スコープ外 (= 報告しても対応しない)

- **物理アクセスを前提とした攻撃** (= サーバホストにシェルがあれば何でもできる)
- **ホスト OS / Docker daemon / Postgres の既知 CVE** (= upstream の責務)
- **AUTH_TOKEN を知っている user が悪意ある操作をする** (= 信頼境界の内側)
- **API key を盗まれた前提の攻撃** (= ユーザの API key 管理責任)
- **ユーザ自身が `data/` に upload した素材** (= ユーザの自己責任)
- **DoS** (= rate-limit / WAF の責任は配備側)
- **第三者の外部サービス側の脆弱性** (= Anthropic / Google / Spotify 等)

スコープ外と判断した場合、その旨をお返事しますが、修正は行いません。

---

## ディスクロージャ ポリシー

- **修正リリース前にパブリック開示しないでください** (= 報告から修正までの間、exploit 情報を公開しないことを希望します)
- 修正リリース後 14 日経過したら、報告者と相談の上でディスクロージャに進みます
- 報告者の同意があれば、commit message / CHANGELOG / SECURITY ADVISORY に名前を記載します (= "X さんの報告により修正"、希望しない場合は匿名で OK)

---

## 過去の対応履歴

本プロジェクトは公開前に **Phase D セキュリティハーデニング** で以下を実施しています:

- 認証ゲート (`AUTH_TOKEN` + `X-Internal-Auth` + Caddy HTTPS)
- SSRF 対策 (`safeFetch` + DNS resolve + private IP 弾き + IPv4-mapped IPv6 対応)
- OAuth トークンの at-rest 暗号化 (AES-256-GCM, ENCRYPTION_KEY)
- timer prompt injection 対策 (= timer-mode の tool allowlist 化)
- 例外メッセージ漏洩の sweep (= `clientError()` ヘルパに統一)
- VRM / BGM upload の magic byte 検証 + 失敗時 cleanup
- Gmail ヘッダインジェクション対策 + メール HTML XSS 多層防御

詳細は git log + [`CLAUDE.md`](CLAUDE.md) を参照。

---

## 連絡先

- **GitHub Security Advisory**: 本リポジトリ Security タブ → "Report a vulnerability"
- **GitHub Issue (= 軽微な指摘 / 公開可能な内容のみ)**: `security` ラベル付きで作成

ご報告ありがとうございます。
