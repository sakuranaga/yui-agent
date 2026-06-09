# Spotify 連携セットアップ

Yui の音楽機能 (検索・再生・スキップ・音量制御等) は Spotify Web API 経由で動く。
Spotify Developer の登録は無料で、$99/年 のような費用は発生しない。

> Free アカウントでも検索や「いま流れてる曲」取得は使えるが、`play / pause /
> next / volume / transfer` 等の再生制御は **Spotify Premium** が必須 (Spotify API
> の制限)。Free で連携した場合は MusicModal 上に「Premium が必要です」と
> 表示され、specialist 経由の操作も明示エラーで返る。

## ⚠️ アクセス URL が 2 種類ある点に注意

yui-agent は普段 **`https://localhost:8443`** (Caddy 経由 HTTPS) で使うが、
**Spotify 連携の OAuth フローだけは `http://127.0.0.1:3000` 経由**で実行する必要がある。

理由: Spotify は 2025 以降のポリシーで redirect URI に以下の制限を課している:

- `localhost` は許可しない (= `127.0.0.1` のみ)
- 自己署名 HTTPS は "Insecure" として拒否 (= loopback は HTTP のみ許可)

そのため、yui-agent では Spotify OAuth 専用に `http://127.0.0.1:3000` を
loopback bind してある (compose の `127.0.0.1:3000:3000`)。連携完了後は
ブラウザを `https://localhost:8443` に戻して通常利用すれば、保存された refresh
token がそのまま使われる。

## 1. Spotify Developer アプリを作る

1. <https://developer.spotify.com/dashboard> にログイン
2. **Create app** → 適当な名前・説明 (Yui personal 等) を入力
3. **Redirect URI** に次の値を **完全一致** で追加 (末尾 `/` の有無もチェック):

   ```
   http://127.0.0.1:3000/api/spotify/callback
   ```

4. **Which API/SDKs are you planning to use?** は **Web API** と **Web Playback SDK** にチェック
   - Web Playback SDK にチェックすると `streaming` / `user-read-email` scope が
     自動 grant される (= ブラウザで直接再生する場合に必要)
5. 規約同意 → Save
6. アプリの設定画面に表示される **Client ID** と **Client Secret** をコピー

## 2. yui-agent に Client ID / Secret を登録

1. yui-agent を起動 (`docker compose up -d`)
2. ブラウザで **`http://127.0.0.1:3000/settings`** を開く (= OAuth フロー用)
3. **Spotify 連携** セクションの 2 つの入力欄に Client ID / Client Secret を貼り付け
4. **保存** ボタン
5. **Spotify と連携** ボタン → Spotify の同意画面 → 戻り先 `/settings?spotify_connected=1`
6. 連携完了後は **`https://localhost:8443`** に戻って OK (= 普段の利用 URL)

## 3. 動作確認

- 設定画面に `Connected ✓ <display_name>` と Premium / Free バッジが出れば成功
- アイコンバーの **MUSIC** ボタンで MusicModal を開くと、Spotify Connect で見えてる
  デバイス一覧が drop-down に出る
- Spotify アプリを 1 度開いてアクティブ化しておくと、Yui の「ジャズ流して」等の
  依頼で実際にそこに音楽が流れる

## トラブルシューティング

| 症状 | 原因と対処 |
|------|------------|
| 「再生可能なデバイスが見つかりません」 | Spotify アプリ (PC / スマホ / Web Player いずれか) を 1 度開いてアクティブ化する。Spotify Connect は「直近で開いてた」デバイスを target にする |
| 「Spotify Premium が必要です」 | Free アカウントの仕様上の制限。検索と曲情報取得までしか動かない |
| OAuth callback で `state mismatch` | ブラウザ Cookie が消えた or 別ブラウザで開いた。`/settings` で再連携 |
| 連携後すぐ「未連携」に戻る | Client Secret 入力ミス。/api/spotify/status の error に Spotify の応答が出る |
| Spotify Dashboard で `Invalid redirect URI` | Dashboard 側の Redirect URI に `http://127.0.0.1:3000/api/spotify/callback` を **完全一致**で登録する。`localhost` や末尾 `/` の有無もチェック |
| 認可画面で `redirect_uri: Insecure` | 自己署名 HTTPS (`https://localhost:8443`) で連携を試みた。OAuth フローだけは **`http://127.0.0.1:3000/settings`** から実行する必要がある (Spotify policy で loopback HTTPS 自己署名は拒否) |
| 認可画面で `redirect_uri: Not matching configuration` | `.env` の `SPOTIFY_REDIRECT_URI` と Spotify Dashboard 登録値が不一致。両方とも `http://127.0.0.1:3000/api/spotify/callback` で揃える |
| ブラウザ console に `Invalid token scopes` (Web Playback SDK) | 古い refresh token に `user-read-email` が含まれていない。/settings で **解除 → 再連携**で最新 scope を付け直す |

## .env でセットする場合 (任意)

DB 保存ではなく `.env` で固定したい場合 (= 多人数で同じ docker image を回す等):

```
SPOTIFY_CLIENT_ID=xxx
SPOTIFY_CLIENT_SECRET=xxx
```

DB 値が優先されるので、UI で別の値を入れると上書きされる。
