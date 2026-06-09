# Google OAuth セットアップガイド (Yui 用)

Yui の `schedule_specialist` / `mail_specialist` から **Google の公式 hosted MCP** (`calendarmcp.googleapis.com` / `gmailmcp.googleapis.com`) を呼ぶには、OAuth クライアントを 1 度だけ Google Cloud Console で発行する必要があります。所要時間 10〜15 分。

## 0. 前提

- Personal Gmail アカウント (このガイドの想定)
- ブラウザで <https://console.cloud.google.com/> にログイン済み

## 1. GCP プロジェクト作成

1. 画面上部の「プロジェクトを選択」プルダウン → 「新しいプロジェクト」
2. プロジェクト名: `yui-personal` (何でも可)
3. 組織: なし (個人 Gmail なら自動的に「組織なし」)
4. 「作成」→ 数秒待って、画面上部で作成したプロジェクトに切り替え

## 2. API を有効化

「APIとサービス」→「ライブラリ」で以下を検索 → 各「有効にする」。
**MCP API** (`gmailmcp.googleapis.com` / `calendarmcp.googleapis.com`) は Anthropic の
`mcp_servers` から直接叩く本体なので必須。データ API (Gmail API / Google Calendar API)
は MCP の内部で使われる可能性があるので念のため一緒に有効化。

必須 (MCP):
- **Gmail MCP API**
- **Calendar MCP API**

念のため (内部依存):
- **Gmail API**
- **Google Calendar API**

検索キーワードに `mcp` を入れると MCP 系がヒットしやすい。

## 3. OAuth 同意画面の設定

「APIとサービス」→「OAuth 同意画面」:

1. **User Type: External** を選択 → 作成
2. アプリ情報:
   - アプリ名: `Yui (personal)`
   - ユーザーサポートメール: 自分の Gmail
   - デベロッパー連絡先: 自分の Gmail
3. **スコープ**: 何も追加せず「保存して次へ」(スコープは Yui 側でリクエスト時に指定するため)
4. **テストユーザー**: 自分の Gmail アドレスを 1 つ追加 → 「保存して次へ」
5. 概要を確認 → 「ダッシュボードに戻る」

> External + Testing モードのままで OK。本番公開しないので審査不要。テストユーザーに登録した Gmail だけが連携可能。

## 4. OAuth クライアント作成

「APIとサービス」→「認証情報」→ 「認証情報を作成」→「OAuth クライアント ID」:

1. **アプリケーションの種類: ウェブアプリケーション**
2. 名前: `Yui local dev`
3. **承認済みのリダイレクト URI** に以下を追加:

   ```
   http://localhost:3000/api/auth/google/callback
   ```

4. 「作成」 → モーダルで **クライアント ID** と **クライアントシークレット** が表示される。両方コピーして安全な場所にメモ。

> 本番でドメインを使うようになったら、リダイレクト URI に本番 URL も追加する。今は localhost で十分。

## 5. Yui 側の `.env` に投入

リポジトリの `.env` に以下を追記 (`.env.example` 参照):

```bash
# Google OAuth (Phase B continuation)
GOOGLE_CLIENT_ID=xxxxxxxxxxxx-xxxxxxxxxxxxxxxxxx.apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=GOCSPX-xxxxxxxxxxxxxxxxxxxxx
GOOGLE_REDIRECT_URI=http://localhost:3000/api/auth/google/callback
```

その後 Docker を再起動:

```bash
docker compose restart web
```

## 6. ブラウザで連携

1. <http://localhost:3000/settings> を開く
2. **「Google を連携」** ボタンを押す → Google の同意画面が新規タブで開く
3. 自分の Gmail でログイン → スコープ (Calendar 読取 / Gmail 読取) を確認 → 許可
4. Yui の `/settings` に戻ってきて「Connected ✓」と表示されれば完了

これ以降、Yui に「今日の予定」「未読メール」と聞けば schedule/mail specialist 経由で答えるようになります。

## トラブルシューティング

- **「このアプリは Google で確認されていません」と警告**: 「詳細」→「(unsafe) アプリに移動」で進める。Testing モードの External クライアントの正常挙動。
- **`redirect_uri_mismatch` エラー**: GCP 側のリダイレクト URI が `.env` の `GOOGLE_REDIRECT_URI` と完全一致しているか確認 (末尾スラッシュ、http/https、ポート番号)。
- **同意画面で「アクセスをブロックしました」**: テストユーザーに自分の Gmail が登録されていない。手順 3-4 を確認。

## 後で変更する場合

- スコープ追加 (例: Calendar 書き込み): `src/lib/google-oauth.ts` の `SCOPES` 配列に追加 → 一度 `/settings` で disconnect → 再 connect (新スコープで同意画面が出る)
- 別 Google アカウントに切替: `/settings` で disconnect → 別アカウントで connect
- トークンは Postgres `google_oauth_tokens` テーブルに保存。手動削除したい時は psql で `TRUNCATE google_oauth_tokens;`
