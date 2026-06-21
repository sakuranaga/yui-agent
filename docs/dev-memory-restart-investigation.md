# Dev Server Memory Restart Investigation

調査日時: 2026-06-21 19:32 JST

## 背景

ツール改善テスト中に、画面が突然リロードされた。Docker コンテナ自体のクラッシュではなく、Next.js dev server がメモリ閾値接近を検知して自己再起動した可能性が高い。

## 観測ログ

`docker compose logs --since 40m web` で以下を確認。

```text
⚠ Server is approaching the used memory threshold, restarting...
▲ Next.js 16.2.7 (webpack)
✓ Ready in 278ms
```

再起動直前には、チャット、specialist job、確認付き削除、voice 生成、TTS、各種 polling が連続していた。

## 実測値

`docker stats --no-stream yui-agent-web yui-agent-postgres yui-agent-valkey`

```text
yui-agent-web        1.936GiB / 7.75GiB   24.98%
yui-agent-postgres   119.9MiB / 7.75GiB    1.51%
yui-agent-valkey     8.773MiB / 7.75GiB    0.11%
```

web コンテナ内 cgroup:

```text
memory.current = 2557489152 bytes
memory.max     = max
```

つまり、Next.js が再起動した直後でも web コンテナは約 1.9-2.6 GiB 程度を使用していた。

## 現在の起動条件

`docker-compose.yml`:

```yaml
command: npm run dev
environment:
  - NODE_ENV=development
  - WATCHPACK_POLLING=true
  - CHOKIDAR_USEPOLLING=true
```

`package.json`:

```json
"dev": "next dev --webpack -H 0.0.0.0"
```

`next.config.ts`:

```ts
experimental: {
  proxyClientMaxBodySize: "70mb",
}
```

## 推定原因

主因はアプリロジックの明示的な再起動ではなく、Next.js dev server の自己防衛再起動。

可能性が高い要因:

- `next dev --webpack` の HMR / dev watcher
- Docker for Mac 用の `WATCHPACK_POLLING=true` / `CHOKIDAR_USEPOLLING=true`
- 長時間接続の SSE (`/api/chat/stream`)
- VRM / 3D 系アセットと webpack dev cache
- チャット中の tool gate / executor / specialist / voice / TTS の連続実行
- `calendar/events` や `project-links` など大きめの API レスポンス
- mail polling / weather / Spotify polling などの周期処理

## 現時点の判断

本番ロジックの致命的バグというより、開発モードのメモリ圧が主因と見る。

ただし、dev server 再起動は画面フラッシュや SSE 切断を引き起こすため、ツール改善が一段落した後に対処する。

## 後で行う調査・対策候補

1. production mode で再現確認
   - `next build` + `next start` 相当で起動し、同じチャット・カレンダー操作を実行する。
   - dev watcher / HMR が消えるため、再起動が消えるか確認する。

2. polling watcher の見直し
   - `WATCHPACK_POLLING=true`
   - `CHOKIDAR_USEPOLLING=true`
   - Docker for Mac で必要な場合でも、interval 指定や対象除外で負荷を下げられるか確認する。

3. メモリ計測ログ追加
   - `/api/chat`
   - specialist job
   - confirm final voice
   - TTS
   - `/api/calendar/events`
   - `/api/project-links`

   各処理の前後で `process.memoryUsage()` を記録し、増加して戻らない箇所を特定する。

4. 大きいレスポンスの確認
   - `/api/project-links?artifactIds=...` が大量 ID を一度に処理している。
   - カレンダー表示範囲・project link lookup の chunking / cache を検討する。

5. dev compose と prod compose の運用整理
   - 普段使いは `production-like` 起動に寄せる。
   - コード変更作業時だけ `npm run dev` を使う構成を検討する。
