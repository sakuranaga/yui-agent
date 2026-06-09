# アーキテクチャ

Yui Agent の全体構造、リクエストフロー、Star パターン、Periodic Module System の解説。

---

## 1. リクエストフロー (会話 1 ターン)

```
User 発話
  ↓
ChatPanel (client)
  ├─ POST /api/chat
  │   ↓ Yui ターン (Sonnet / Opus / 他 provider)
  │   ├─ 明示メトリクス quick-save (= 体重 / 体脂肪 / 気分 等を Yui 応答前に regex 即時保存)
  │   ├─ env block 注入 (= 時刻 / 天気 / 音楽 / timer / ユーザー状態)
  │   ├─ memory retrieval (= L2 always-on + L3 session summary + L4 semantic)
  │   ├─ 会話履歴 N ターン (= CHAT_HISTORY_TURNS=8、env override 可)
  │   ├─ Tool 呼び出しループ:
  │   │   ├─ 同期系 tool (= web / timer / todo / contact / health / news 等)
  │   │   └─ ask_*_specialist (= Haiku judge → 必要なら background dispatch)
  │   ├─ text 応答 → sanitize → 即時 TTS
  │   └─ post-turn: food/workout extract + intent dispatch (= 5 分 debounce)
  └─ EventSource /api/chat/stream で SSE 接続
       ↓ background dispatch / notification / periodic fire が来たら…
       voice formatter (= Haiku 等のサブモデル) で結衣口調に整形
        └─ SSE push → 追加 chunk + TTS
```

- 主応答 (= text + initial tool 結果) と非同期応答 (= specialist 完了通知 / notification) は別経路
- 同じ session_id 内の SSE event は全て同じ ChatPanel に push される
- voice formatter は specialist の factual な出力を「結衣の口調」に整形する役割

---

## 2. Star パターン (Yui を hub にした集約)

```
                      ┌── GCal (schedule)
       ┌── ask_*_*  ──┼── Gmail (mail)
       │              └── Spotify (music)
Yui ───┤
(主)   ├── 同期 tool (= web / timer / todo / contact / diary / news / health / music 制御 等)
       │   ── Postgres + Valkey + SearXNG
       └── env block 自動注入 ── time / weather / music / timer / user state
```

- **specialist 同士は通信しない**、常に Yui が hub
- 各 specialist (mail / schedule / music) は availability 自動 detect (= OAuth / API key 未設定なら tool 一覧から外れる)
- specialist は内部で更に細かい tool を使う (= 例: mail specialist が `gmail_search` を呼ぶ) が、Yui main からは `ask_mail_specialist` 1 つに見える

### 二重応答防止 (= Haiku Judge)

specialist dispatch 前に Haiku judge が「env block で答え切れる?」を判定 → 不要なら physical skip。これで「Yui が直答した直後に specialist が同じ内容を別声で再返答する」事故を防ぐ。

### Timer-mode の特殊権限制限

`source: "timer"` で chat route が呼ばれた場合 (= timer の `onFirePrompt` 発火経路)、tool allowlist が絞られる:
- 許可: read-only 系 + 音楽 playback + `ask_music_specialist`
- 禁止: send_mail / 予定作成 / 連絡先編集 / timer 自身の作成削除 等
- これは prompt injection 対策 (= 保存 prompt が「過去の信頼済 user 入力」とは限らないため、副作用 tool に到達させない)
- 詳細: `docs/deployment-and-security.md`

---

## 3. セッション管理

- `localStorage` (`vroid-chat-session-id`) に session_id (UUID v4) を保持
- ChatPanel が初回マウント時に発行 (= 存在しなければ生成、存在すればそのまま)
- 発行時 / 移行時に `window` event `vroid-session-changed` を fire → page.tsx 側の TimerToast が捕捉して SSE 接続先を同期
- raw_messages / memory_chunks / timers / notifications はすべて session_id で紐付け
- **memory retrieval は session フィルタしない** → 長期記憶は全 session 横断
- 履歴 fetch は limit=100 (max 500)、会話 window は 8 ターン (`CHAT_HISTORY_TURNS`)
- プライベートモード時のみ Valkey overlay (24h TTL) に書き、DB の raw_messages には残さない

---

## 4. Periodic Module System

`src/periodic/` 配下の固定 interval 評価モジュール。`src/lib/scheduler.ts` が起動時に in-process で `setInterval` 設定。

| モジュール | 用途 | 頻度 |
|---|---|---|
| `calendar-check` | Google Calendar 同期 (= 直近予定検知 + 朝のブリーフに渡す) | 5 分 |
| `mail-poll` | Gmail poll + 分類 + 自動アクション | 5 分 |
| `news-fetch` | RSS 6 ソース fetch + Haiku キュレーション | 1 時間 |
| `morning-check` | 朝のブリーフィング配信 (= 1 日 1 回 fire 判定) | 5 分間隔判定 |
| `diary-write` | 日記自動生成 (= Catch-up logic で前日分が無ければ補完) | 1 時間 |
| `memory-decay` | importance 減衰 + 閾値割れ row の auto invalidate | 1 日 |
| `memory-cleanup` | invalidated chunk の物理削除 + 関連メタデータ整理 | 1 日 |
| `profile-snapshot` | ご主人様プロファイル スナップショット生成 (= ユーザの最近の発話傾向 / 嗜好を要約) | 1 日 |
| `reminder-dispatch` | 期日到達リマインダーの fire + 朝のブリーフへの集約 | 1 分 |

### 設計上のポイント

- **判定段で LLM 使わない** (= ルールベースで cron 的に発火するだけ、LLM call は `fire` 時のみ Yui 1 ターン起動の中で消費)
- **アトミックな job claim** (= `src/lib/job-claim.ts` の `claimJob({key: "..."})` + `jobClaims` テーブル + INSERT ON CONFLICT DO NOTHING) で同時起動防止 (= `memory-decay` 等が日付別 key で 1 日 1 回しか claim できない)
- **scheduler 二重発火対策**: `src/lib/scheduler.ts` 内で in-flight Set lock を持ち、interval が前回の実行と被ったら skip

### 開発時の注意

`src/periodic/*` を編集した時は **`docker compose restart web`** が必要。Next.js HMR では古い `setInterval` が回り続けるので変更が反映されない。

---

## 5. 拡張ポイント

新規 specialist 追加 / 新規 periodic モジュール追加の手順:

### 新規 Specialist

1. `src/lib/specialists/<name>.ts` を作成 (例: `music.ts` を参考)
2. `yuiToolName: "ask_<name>_specialist"` を export
3. 内部 tool を定義 (= Yui main からは見えない、specialist 内部で使う)
4. `src/lib/specialists/registry.ts` の registry に追加 (= 自動収集される
   pattern なら不要、明示登録 pattern なら追記)
5. availability 検知 (= OAuth / API key が無いなら Yui main の tool 一覧から外す
   ロジック) を `registry.ts` 経由で実装

### 新規 Periodic Module

1. `src/periodic/<name>.ts` を作成
2. `evaluate(ctx)` 関数 export
3. `src/periodic/registry.ts` に追加 + interval を設定
4. atomicity が必要なら `claimJob({key: "<name>:<date>"})` で gating
5. `docker compose restart web` で反映

---

## 関連

- `docs/data-persistence.md` — DB テーブル / Valkey / Embeddings
- `docs/deployment-and-security.md` — 認証 / SSRF / clientError / OAuth 暗号化
- `docs/feature-overview.md` — 各機能の概要
- `CLAUDE.md` — エラー処理 / セキュリティ規約
