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

## 2026-06-23 追加調査: MusicModal 操作時のフラッシュ

ユーザー操作:

- チャット入力
- その直後に MusicModal を開く
- 画面フラッシュを目視

この再現では、web コンテナ自体の restart / OOMKill は発生していない。

```text
StartedAt=2026-06-23T02:04:35.774581887Z
RestartCount=0
OOMKilled=false
ExitCode=0
```

また、フラッシュ時刻付近に Next.js dev server の自己再起動ログも出ていない。

出ていないログ:

```text
⚠ Server is approaching the used memory threshold, restarting...
▲ Next.js ...
✓ Ready in ...
```

一方で、該当時刻には以下が発生していた。

```text
08:16:00 POST /api/chat
08:16:10 chat completed
08:16:12-20 POST /api/tts
08:16:30 GET /api/spotify/now-playing
08:16:31 GET /api/music/history?limit=15
08:16:31 GET /
08:16:31 GET /api/music/history?limit=15
```

メモリは約 2.14GB から 2.36GB へ増加したが、Next dev の再起動閾値には到達していない。

```text
08:15:59 memory.current=2143621120
08:16:09 memory.current=2150916096
08:16:14 memory.current=2295140352
08:16:30 memory.current=2328776704
08:16:35 memory.current=2360356864
```

zombie `esbuild` 数は 25 のまま増えていない。

```text
zombies=25
```

### 判断

今回の MusicModal 操作時フラッシュは、2026-06-21 に確認した
`Server is approaching the used memory threshold` 系の dev server 自己再起動とは別系統。

ユーザー意図として MusicModal の blur / fade はデザイン要件なので、これを削る対策は採用しない。

現在の候補は以下。

1. MusicModal の backdrop / blur / fade-in による視覚的な全画面フラッシュ
   - `.music-modal-backdrop` は `background: rgba(8, 10, 18, 0.62)` と `backdrop-filter: blur(4px)` を画面全体に適用する。
   - 開いた瞬間に VRM / 背景全体が暗転・ぼかしになり、ユーザー体感としてフラッシュに見える可能性がある。

2. MusicModal open と同時に発生する `GET /`
   - MusicModal のコード自体には `/` への明示的 fetch / navigation は見当たらない。
   - `page.tsx` には `useRouter()` を使う setup 判定があり、親ページ再描画や Next dev runtime の内部処理と合わせて `GET /` が発生している可能性がある。
   - ただし、この `GET /` だけでは full reload とは断定できない。直後に初期化系 API (`/api/setup/status`, `/api/vrm/current`, `/api/chat/history`) が一斉に再実行された形跡は薄い。

3. チャット完了直後の TTS / stats 更新 / Spotify polling / Music history fetch が重なり、描画が詰まって瞬間的な白黒変化に見える可能性
   - チャット完了直後に TTS が 3 回実行され、その後 MusicModal の now-playing / history fetch が走っている。
   - ただしサーバ側メモリ・プロセス状態からは、再起動や crash ではない。

### 切り分け方

次の順で確認する。

1. MusicModal backdrop の `backdrop-filter` と enter animation を一時的に無効化して、同じ操作でフラッシュが消えるか確認する。
2. `GET /` の発生源を特定するため、開発時のみ `pagehide` / `beforeunload` / `visibilitychange` / mount count を console に出す軽量計測を入れる。
3. `GET /` が full reload でない場合は、MusicModal の視覚効果を弱める修正を優先する。
4. `GET /` が full reload の場合は、`page.tsx` の setup 判定 / router 依存 effect / Next dev runtime の挙動をさらに追う。

### 追加で見つかった問題

web コンテナ内に zombie `esbuild` が蓄積している。

```text
next-server RSS ~= 2.0g
esbuild zombie ~= 25
```

zombie は RSS を消費していないため今回のフラッシュの直接原因ではないが、PID 1 が child process を reap できていない状態なので、`docker-compose.yml` の web service に `init: true` を入れる候補がある。

## 2026-06-23 追加調査: 時間経過後の初回操作が重い / 自発通知が混ざる

ユーザー観測:

- 時間を置いたあとに発生しやすい。
- 初回の各モーダル読み込みが遅い。
- リロード後にチャットすると、ニュースお知らせや他トリガーが発話することがある。

### ログ上の実態

該当時刻では、チャット POST の開始直後に `tickMaintenance()` が走り、scheduler が初回登録されている。

```text
07:57:40 [startup] running first maintenance pass
07:57:40 [scheduler] registered calendar-check (interval 300s)
07:57:40 [scheduler] registered diary-write (interval 300s)
07:57:40 [scheduler] registered news-fetch (interval 10800s)
07:57:40 [scheduler] registered morning-check (interval 300s)
07:57:40 [scheduler] registered memory-decay (interval 300s)
07:57:40 [scheduler] registered memory-cleanup (interval 3600s)
07:57:40 [scheduler] registered mail-poll (interval 600s)
07:57:40 [scheduler] registered profile-snapshot (interval 3600s)
07:57:40 [scheduler] registered reminder-dispatch (interval 60s)
07:57:40 [scheduler] registered tool-exec-cleanup (interval 3600s)
07:57:41 [news-fetch] sources=5 fetched=117 inserted=70 errors=0
07:57:42 [executor-input] recentHistory=1件(user-only) last="やあ。元気？"
07:57:49 [chat] ... total=8375ms
07:57:49 [mail-poll] accounts=1 fetched=103 inserted=59 ...
07:57:49 [mail-curate] target=59 ... to_llm=59 need_body=59
```

DB でも同時刻にニュース通知と大量のメール通知が作成されている。

```text
2026-06-23 16:58:27 news           新着ニュース 7/55 件
2026-06-23 16:59:01 mail_important / mail_other が多数
```

つまり、リロード後または長時間経過後の最初のユーザー操作が `/api/chat` だと、
ユーザーのチャット処理と同じタイミングで以下が同時に走る。

- startup first maintenance
- scheduler 登録
- overdue な periodic module の initial tick
- news fetch / curate / notification
- mail poll / mail curate / notification
- stale session extract
- prune 系 maintenance

これが、以下の体感につながっている。

- 初回チャットが重い
- 画面が詰まる / フラッシュしたように見える
- ユーザー発話への返答とは別のニュース・メール・予定通知が混ざる

### 「DB直ならもっと速いはず」について

MusicModal の初回 API は DB そのものより Next dev 側の初回 route load / compile コストが支配的。

```text
GET /api/spotify/now-playing 200 in 1540ms (next.js: 1387ms, application-code: 138ms)
GET /api/music/history?limit=15 200 in 925ms (next.js: 817ms, application-code: 101ms)
```

`application-code` は 100ms 前後なので、DB 直アクセスが遅いというより、
dev mode の route handler 初回ロード / webpack runtime / Docker polling / module import が重い。

ユーザー観測として、Dev 表示の左下 Next アイコンもたびたび compile っぽい動きをしている。
これは上記ログの `next.js` 時間増加と整合する。特に初回アクセスでは:

```text
POST /api/chat 200 in 11.6s (next.js: 3.2s, application-code: 8.4s)
GET /api/spotify/now-playing 200 in 1540ms (next.js: 1387ms, application-code: 138ms)
GET /api/music/history?limit=15 200 in 925ms (next.js: 817ms, application-code: 101ms)
```

一方、同じ endpoint の 2 回目以降は:

```text
GET /api/music/history?limit=15 200 in 23ms (next.js: 1949µs, application-code: 9ms)
GET /api/spotify/now-playing 200 in 98ms (next.js: 16ms, application-code: 68ms)
```

つまりモーダル初回遅延は、DB ではなく Next dev の cold route / cold chunk の影響が大きい。
これは production-like 起動、または dev 起動後の prewarm で軽減できる。

### 根本原因

現状の startup は `/api/chat` の hot path で `tickMaintenance()` を fire-and-forget している。

```ts
// src/app/api/chat/route.ts
tickMaintenance();
```

さらに scheduler は、登録直後に `periodic_state.last_run_at` を見て interval 経過済みなら initial tick を即実行する。

```ts
void shouldInitialTick(mod).then((should) => {
  if (should) void tick(mod)
});
```

この設計は「サーバ再起動後に周期処理を取りこぼさない」利点がある一方、
個人 assistant の UI では「ユーザーが最初に話しかけた瞬間にバックグラウンド処理が雪崩れ込む」欠点が大きい。

### 修正方針候補

1. `/api/chat` hot path から startup / scheduler catch-up を外す。
   - チャット応答の直前に heavy periodic を起こさない。
   - ユーザー操作と自発通知の混線を減らす。

2. scheduler の initial tick を一律即時実行しない、または heavy module を遅延する。
   - `news-fetch`, `mail-poll`, `memory-*`, `profile-snapshot` は初回登録から数十秒後にずらす。
   - `reminder-dispatch`, `calendar-check` のような時刻厳守系だけ即時/短遅延を許可する。

3. 自発通知の発話をユーザーチャット中は抑制または queue する。
   - notification DB / toast は作る。
   - `speak` / `/api/chat source=cron` は、直近ユーザーターンの処理中なら後ろへ回す。

4. dev mode の初回モーダル遅延は、production-like 起動または prewarm で対処する。
   - production mode では route/chunk の lazy compile が消える。
   - dev mode を継続するなら、起動後に `/api/music/history`, `/api/spotify/now-playing`, `/api/todos`, `/api/calendar/events` など主要 route を軽く prewarm する。

5. web service に `init: true` を追加する。
   - zombie `esbuild` を reap する。
   - 直接のフラッシュ対策ではないが、dev server 長時間運用の衛生改善として有効。

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
