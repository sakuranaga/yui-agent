# Contributing to Yui Agent

Yui Agent への貢献を検討してくださりありがとうございます。本プロジェクトは個人ホスト向けの "embodied secretary" として作られていますが、改善提案 / バグ報告 / プルリクエストはどなたからでも歓迎します。

---

## まず知っておいてほしいこと

### ライセンス

- **コード本体**: [PolyForm Noncommercial 1.0.0](LICENSE) (= 商用販売不可、個人 / 教育 / 研究 / 非営利組織 OK)
- 貢献いただいたコードも同じライセンスで配布されます
- 将来 contributor が増えて合意が取れた場合、より緩いライセンス (= 例: MIT) への変更可能性は残してあります。その際は貢献いただいた方々と相談する形になります

### 同梱アセットの方針

`public/sleep-bgm/` の BGM 等、配布物に同梱する**バイナリアセット**を追加する PR は、以下のいずれかを満たす必要があります:

1. **CC0 / Public Domain** (= 制限なし)
2. **CC BY 3.0/4.0** など、attribution 要件付きの場合は [`CREDITS.md`](CREDITS.md) に出典 / アーティスト / ライセンス URL を追記
3. **再配布不可ライセンス** (= 例: Adobe Stock standard license) は不可

判断が難しい素材は同梱せず、ユーザ各自で `data/` 配下に配置する仕組み (= 現在の VRM / BGM upload) を活用してください。

---

## 開発環境セットアップ

### 必要なもの

- Docker / Docker Compose (= Mac は Docker Desktop、Linux は素の Docker でも可)
- Anthropic / OpenAI / Gemini / Grok のいずれかの API key (= 動作確認に必要)
- 推奨: Ollama (= Embeddings 用、`bge-m3` モデル)

### 初回セットアップ

```bash
git clone <repo url>
cd vroid

# .env 必須項目を作る
echo "AUTH_TOKEN=$(openssl rand -base64 32)" >> .env
echo "ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env

# 起動
docker compose up -d

# DB migrate (= 初回 + schema 変更時)
docker compose exec web npm run db:migrate
```

- `https://localhost:8443` (Mac 高 port 構成) でアクセス
- `/auth` で AUTH_TOKEN を貼り付け → cookie 認証
- `/setup` ウィザードで AI provider key + Embeddings を入力
- 詳細は [README.md](README.md) 参照

### ホスト側ルール

`CLAUDE.md` (= プロジェクト規約) にあるように、本リポジトリでは:

- **ホストマシン上で `npm install` 等を直接走らせない** (= 依存は Docker 内で完結)
- **dependency 追加は理由を説明 + lockfile commit**
- **ホスト側に sensitive credentials (`.ssh`, `.aws` 等) を container にマウントしない**

---

## コードスタイル

### 言語 / フレームワーク

- TypeScript (= 厳格モード、any 禁止)
- Next.js 16 App Router + React 19 (= 旧 `middleware.ts` は Next 16 で `proxy.ts` にリネーム)
- Drizzle ORM (= migration は `src/db/migrations/*.sql`)
- ESLint + 標準的な Next.js 設定

### コメントの言語

- **日本語 OK** (= 既存コードは日本語と英語が混在)
- 関数や API endpoint の docstring は「何のために、いつ呼ばれるか」を書く (= "what" より "why")

### コミットメッセージ

- 1 行目: 何を変えたかの要約 (= 例: `Phase D1: OAuth token at-rest 暗号化`)
- 本文: 設計意図 / 影響範囲 / 留意点
- 日本語 OK
- 機能名 + Phase 番号があれば prefix にする (= `Phase X: ...`)

### Lint / 型チェック

PR を出す前に以下が通ることを確認してください:

```bash
docker compose exec web npx tsc --noEmit  # 型チェック
docker compose exec web npm run lint      # ESLint
```

既知の pre-existing なエラー (`apps/discord-bot/` の discord.js 型不一致など) は無視して構いません。あなたの変更箇所が新規エラーを増やさないことだけ確認してください。

---

## エラーハンドリング規約 (重要)

詳細は [`CLAUDE.md`](CLAUDE.md) §「エラーハンドリング」を参照してください。要約:

- API route の catch ブロックで **`e.message` / `String(e)` を直接 client に返さない**
- `src/lib/api-error.ts` の `clientError(req, e, { ... })` を使う
- server log には full detail + stack、client には固定の安全メッセージ
- callback redirect / errors[] 配列も同じルール

新規 route を追加する PR でこれが守られていない場合、修正をお願いすることがあります。

---

## PR / Issue の出し方

### Issue

- バグ報告: 再現手順 / 期待する挙動 / 実際の挙動 / 環境 (= OS / Docker / ブラウザ) を含めてください
- 機能提案: 「なぜそれが必要か」を中心に。実装方針より動機が大事
- 質問: GitHub Discussions の方が向いてますが、Issue でも歓迎

### Pull Request

1. **feature branch を切る** (= `feature/xxx` または `fix/xxx`)
2. **小さく出す** (= 1 PR = 1 関心事。複数の独立した変更が混ざるとレビューしにくい)
3. PR の説明に「何を / なぜ / どう動作確認したか」を書く
4. レビュー後、必要に応じて修正 → merge

### 大きな変更 (= リファクタリング / 新機能)

実装に入る前に **Issue で設計を相談**してください。本プロジェクトは個人運用前提で内部設計が固有なものが多く、いきなり大きな PR が来ても merge が難しい場合があります。

特に以下の領域は事前合意が必須:

- `src/app/api/chat/route.ts` (= Yui の core ループ、tool 構造、specialist dispatch)
- 認証 / セキュリティ (`src/proxy.ts`, `src/lib/safe-fetch.ts`, `src/lib/crypto.ts`)
- DB schema 変更 (= migration を伴うもの)
- 外部 API 統合 (Google / Spotify / Discord 等)

---

## レビューの基準 (= maintainer 視点)

私 (= maintainer) は以下の観点で見ます:

1. **セキュリティ**: SSRF / 例外漏洩 / 認証バイパスなど、過去対策した経路を壊していないか
2. **設計の一貫性**: 既存パターン (= clientError / safeFetch / job claim 等) を踏襲しているか
3. **動作確認**: 「テストしました」だけでなく、何をどう確認したか
4. **コメント**: 「why」が書かれているか、自明な「what」だけになっていないか

---

## レスポンス速度について

本プロジェクトはソロ個人 maintainer (= 私) が業務外の時間で運用しています。以下を理解しておいてください:

- Issue / PR への一次返信は通常 1-7 日程度
- 大きな PR のレビューは 1-2 週間かかることがあります
- 急ぎ対応はできません (= 急ぎの修正が必要なら fork して自分用に運用してください)
- 緊急のセキュリティ問題は [SECURITY.md](SECURITY.md) を参照

---

## 開発の方向性 (= 何が welcome か)

歓迎度高め:

- バグ修正 / セキュリティ強化
- ドキュメント整備 / typo 修正
- 既存機能の改善 (= 体感の polish)
- アクセシビリティ向上
- パフォーマンス改善
- テスト追加 (= 現状 test 整備が薄い)

事前相談が必要:

- 新規 specialist 追加
- 新規外部 API 統合
- 大きな UI 構造変更 (= モーダル統廃合等)
- 新しい依存パッケージ追加

合致しないもの:

- 「unrelated にしか見えないリファクタ大量」(= scope が広すぎる)
- 「商用化のための変更」(= ライセンス趣旨に反する)
- 「他プロジェクトに転用するための変更」(= Yui Agent としての一貫性を損なう)

---

## 参考リソース

- [`README.md`](README.md) — プロジェクト概要 / セットアップ
- [`LICENSE`](LICENSE) — PolyForm Noncommercial 1.0.0
- [`CREDITS.md`](CREDITS.md) — 同梱アセットの attribution
- [`SECURITY.md`](SECURITY.md) — 脆弱性報告
- [`CLAUDE.md`](CLAUDE.md) — AI 向け / 開発者向け規約 (= エラー処理 / 認証 / OAuth 暗号化 等)
- [`docs/`](docs/) — 機能設計ドキュメント

質問があれば気軽に Issue で聞いてください。
