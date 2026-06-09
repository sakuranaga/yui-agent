# Roadmap (検討中の機能メモ)

実装前のラフ設計メモ。順番・スコープは着手時に再検討すること。

---

## 1. Todos (Wishlist + TODO + Plane タスク統合) — ✅ 実装済

「読みたい本」「欲しい商品」「行きたい店」「ちょっとした TODO」「project 作業」
すべてを 1 つの `todos` テーブルで管理。Plane を完全置換した自前実装。

- AI 最適化 tool 設計 (1 intent = 1 tool, identifier-first, compact 出力)
- Yui が直接利用 (specialist 経由しない)
- `projects` テーブル (任意の上位コンテナ、Gantt 用 start/due 持ち)
- 自由テキスト `tags TEXT[]` で横断ラベル
- state: `backlog` / `in_progress` / `blocked` / `done`
- Gantt 用に `created_at` / `start_at` / `due_at` / `completed_at` / `estimate_hours`
- 旧 Plane data は `external_ref="WORK-42"` で保持、その名で検索可

Yui tool: add_todo / update_todo / complete_todo / delete_todo / list_todos /
get_todo / search_todos / list_projects / add_project / archive_project

---

## 2. Metrics (健康指標・時系列数値)

体重、血圧、ベンチプレス PR、睡眠時間など、数値+単位の時系列ログ。
"今月の体重推移" "ベンチプレスの伸び" などの時系列クエリができるよう構造化。

### memory_chunks との分担

- 趣味嗜好 (定性) → memory_chunks `preference` で既に対応済み → テーブル化不要
- 健康指標 (定量・時系列) → semantic retrieval が苦手 → 専用テーブル

### スキーマ案

```sql
CREATE TABLE metrics (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  metric_type TEXT NOT NULL,    -- 自由文字列 ("体重", "ベンチプレス", "血圧収縮", "睡眠時間" 等)
  value NUMERIC NOT NULL,
  unit TEXT,                    -- "kg", "mmHg", "h" 等
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  note TEXT
);
CREATE INDEX ON metrics (session_id, metric_type, recorded_at DESC);
```

### Yui tool

- `record_metric(type, value, unit?, note?)`
- `query_metrics(type, range?)`  -- range: "today" / "7d" / "30d" / "all"
- `metric_summary(type)`         -- 最新値 + 直近の傾向

### 自然発話からの抽出

「今日ジム行ってきた。ベンチプレス100kgいけた。体重70kgだった」のような自由発話を
そのまま record してくれると UX 上良い。Yui 側で parse して複数 metric を一気に
記録できる prompt にする。

### ヘルスケア連動 (ライフログ化) — 段階的拡張

morning-brief を DB に永続化したのを契機に、ご主人様から「ヘルスケアと連動して
体調チェックも入れたら面白そう」という発案。秘書 Yui が単なる作業支援から
**ライフログ装置 + 健康伴走者**になる方向。Lv 1 から段階的に積む想定。

**Lv 1 — 手入力 + Yui tool 経由 (1〜2 日、Metrics の基本実装と同時)**
- 上記 metrics テーブル + record_metric / query_metrics / metric_summary tool が前提
- 会話例:「体重 70.5 kg だった」「6 時間しか寝てない」「気分 4/5」→ Yui が即 record
- 朝のブリーフィングに「先週の平均体重」「昨夜の睡眠」を含める
- まずここで「何を記録したいか」がご主人様自身に見えてくる → 後の自動化設計が無駄にならない

**Lv 2 — Apple Health 連携 (1〜2 週間)**
- iOS Shortcuts オートメーション (例: 毎朝起床時 / 体重計乗ったタイミング) で
  HealthKit から値を取得 → 自宅 webhook に POST → metrics テーブルへ
- 取り込み対象: 体重 / 睡眠時間 / 歩数 / 心拍 RHR / HRV / 運動カロリー
- Apple Watch 装着者なら情報密度がかなり高い
- セキュリティ: webhook は HMAC 署名、外向き公開なら Cloudflare Tunnel + Access

**Lv 3 — サードパーティ API 直結 (各社 数日〜1 週間)**
- Withings (体重計): OAuth、cron pull で毎朝自動記録
- Oura Ring / Whoop: 睡眠スコア + HRV + 回復スコアが強い
- Garmin Connect / Fitbit: 運動・睡眠・心拍
- Strava: ランニング / 自転車ログ
- 各社共通の取り込み層 (`/api/health/sync/<provider>`) で差し替え可能に

**Lv 4 — 体調チェック + 異常検出 (Habits + Proactive の拡張)**
- 朝のブリーフに「昨夜の睡眠 4 時間ですね、お疲れではないですか?」
- 夜「今日の気分はいかがでしたか?」を結衣から能動的に (Mood 時系列で月次傾向)
- 閾値ベースの能動的声かけ:
  - 「3 日連続で睡眠 6h 未満」→ 結衣「少し休まれた方が」
  - 「体重が 1 週で +1.5kg」→ 結衣「気にしすぎなくてよろしいですが、ちょっと」
  - 「HRV 平均が前月比 -20%」→ 結衣「体調が落ちてるかもしれません」
- 月次サマリ (日記の延長): 体重トレンド / 睡眠パターン / 気分の波

**推奨進行**: Lv 1 を先に走らせて記録の習慣を作る → Lv 2 で自動化 → Lv 3 でデバイス
増やす → Lv 4 で proactive。Lv 3 と Lv 4 は並行可。

**プライバシー / セキュリティ**:
- 健康データはローカル DB に閉じる (外部送信なし)
- Anthropic への prompt に含める値は最小限 (例: 7d 平均値だけ、生 raw は送らない)
- バックアップは postgres dump で本人保管、クラウドには上げない方針

---

## 3. Habits + Proactive (能動的に聞いてくる)

「今日ジム行きましたか？」のように Yui 側から能動的に確認してくれる機能。
metrics の記録忘れ防止が主目的。

**依存**: metrics が先に必要 (「最後にいつ記録したか」を見るため)。

### 既存資産の再利用

- `timer.onFirePrompt` で「指定時刻に Yui が任意の発話/行動を開始する」仕組みは既にある
  (例: 「1分後にポップス流して」)
- これを cron 化すれば、毎朝 8 時等に habits 評価ジョブを走らせて、該当する習慣を
  onFirePrompt で発火させられる

### スキーマ案

```sql
CREATE TABLE habits (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  name TEXT NOT NULL,              -- "ジム", "血圧測定", "体重測定" 等
  linked_metric_type TEXT,         -- metrics.metric_type にリンク (任意)
  cadence_kind TEXT NOT NULL,      -- "every_n_days" | "weekly" | "daily"
  cadence_value JSONB NOT NULL,    -- {"n": 2} / {"days": ["mon","wed","fri"]} / {"at": "08:00"}
  check_at TIME NOT NULL DEFAULT '08:00',  -- 毎日この時刻に評価
  last_asked_at TIMESTAMPTZ,       -- 最後に Yui が聞いた時刻 (しつこさ抑制)
  last_acked_at TIMESTAMPTZ,       -- 「今日は行かない」等の返答を受けた時刻
  active BOOLEAN NOT NULL DEFAULT true
);
```

### 発火ロジック

毎日 `check_at` の時刻に evaluator が回って:

1. linked_metric_type の最終記録 (metrics) と cadence を比較
2. 「今日聞くべき」かを判定
3. 既に同日 `last_asked_at` があればスキップ (1 日 1 回まで)
4. `last_acked_at` が同日内なら拒否されたとみなしスキップ
5. 該当なら onFirePrompt 相当で Yui に発話させる
   - 例: 「今日はジムですね、行かれますか?」

### しつこさ抑制ルール (重要)

- 同じ habit について **1 日 2 回以上聞かない**
- 「今日は行かない」と返ってきたら **当日中は再質問しない** (last_acked_at で判定)
- 連続拒否が N 日続いたら quietly disable して様子見 (要検討)

### コスト懸念 (実装を 6/15 以降に倒す理由)

定期チェック方式は判定に LLM を使うと月額が膨らみやすい:

| 判定方式 | 月コスト概算 |
|---|---|
| 毎時 Sonnet 判定: 24 回/日 × ~$0.05 | ~$36/月 |
| 毎時 Haiku 判定: 24 回/日 × ~$0.01 | ~$7/月 |
| ルールベースのみ + 発火時 Yui 1 ターン | ~$1/月 |

ルールベース (cadence 純粋計算 + last_logged_at 比較) なら API 課金は発火時の
Yui 1 ターンだけで $1 程度に収まる。が、「Yui が状況を読んで賢く話しかけてくる」
感を出すには判定にも LLM が要る。

→ **本格実装は 2026-06-15 Agent SDK サブスク解禁後** にすると、判定 LLM も
   サブスク枠 (Pro $20 / Max $100-200) で吸収できてコスト安全。

それまでに作るならルールベース型 (timer.on_fire_prompt の cron 拡張) に
留めて MVP 運用感を掴む程度に。

### Yui tool

- `add_habit(name, cadence, linked_metric?)`
- `list_habits()`
- `pause_habit(id)` / `resume_habit(id)`
- `delete_habit(id)`

---

## 4. Doc Agent (6/15 以降, Agent SDK サブスク経由)

設計議論や検討結果を自動でドキュメント (md) に保存するエージェント。
今回 roadmap.md を手書きしたような作業を Yui が自動でやってくれる。

### なぜ 6/15 以降?

**2026-06-15 から Claude Agent SDK がサブスク経由で使える** (要 Claude Pro/Max):
- Pro: $20/月クレジット、Max 5x: $100、Max 20x: $200
- **第三者アプリ (= Yui) で Agent SDK 使えばこのクレジット消費** (CLI 限定じゃない)
- クレジット切れ後は通常 API 課金フォールバック (extra usage 有効時)

→ Opus を使う高品質 doc 生成が、サブスク枠の範囲内なら追加コスト無しで回せる。
それまでは Sonnet 4.6 を API で叩く ($3/$15) でも実装可能だが、Opus 品質の
要約・構造化が欲しいので 6/15 を待つ価値あり。

### 用途

- 検討結果の自動 doc 化 (今 roadmap.md を手書きしてるところ)
- 既存 doc の更新提案 (新機能追加時)
- 議論内容の要点抽出 → 構造化 markdown

### 実装メモ

- Yui 主ターンから `dispatch_doc_agent(topic, conversation_excerpt)` で発火
- 出力は `docs/` 配下の markdown
- 既存 doc がある場合は merge proposal を出して人間が承認 (上書きしない)

---

## 5. Deep Research Agent (6/15 以降, Agent SDK サブスク経由)

ネットを徹底的に探索して長文レポートを返すエージェント。ChatGPT Deep Research
や Anthropic Research の自前版。

### なぜ Agent SDK?

- 多段探索 (search → 結果から URL 選定 → fetch → 再 search → 統合) を 10-30 ステップ
  回す必要があり、Opus が現実的だがコスト過大 → サブスク枠で回したい
- 既存の同期 `web_search` / `web_fetch` (SearXNG ベース) は 1-2 hop 用、深掘りには不足

### 用途想定

- 「最新の○○技術について 30 分かけて調べて」
- 「この商品の購入レビューを全部見て、評価傾向まとめて」
- 「○○について反対意見と賛成意見を両方集めて」

### 実装メモ

- background job として実行 (5-30 分のスパン)
- 既存の SearXNG + 必要なら追加 search source (Brave/Tavily 等の補完)
- 進捗を SSE で push (「○○件目調査中…」)
- 完了時に Yui voice + ノートパネルに長文 markdown レポート

---

## 6. Periodic Module System (Phase G の foundation, 着手中)

定期チェック機能を **用途別の独立モジュール** に分離するフレームワーク。
全てを 1 つの cron に詰め込まず、各モジュールが自分の schedule + 判定ロジックを
持つ pattern。

### 構成

```
src/periodic/
├── types.ts                  # PeriodicModule 型定義
├── registry.ts               # 有効モジュール明示一覧 (specialists/registry.ts と同型)
├── calendar-check.ts         # 5min, 予定5分前 fire (実装済)
├── morning-check.ts          # cron "0 7 * * *" 1日1回まとめ
├── mail-check.ts             # cron "0 9-21 * * *" 12回/日
└── todo-digest.ts            # 期限近い todos / blocked 滞留 todos のリマインド

src/lib/scheduler.ts          # registry 読んで setInterval/cron 登録、boot 時 1 回
```

### モジュール interface

```ts
export type PeriodicModule = {
  id: string;
  enabled: boolean;
  schedule:
    | { kind: "interval"; everyMs: number }
    | { kind: "cron"; expr: string };
  run: (ctx: PeriodicContext) => Promise<PeriodicResult>;
};

export type PeriodicResult =
  | { skip: true; reason?: string }
  | { fire: { prompt: string }; reason?: string };
```

ルール判定だけで「fire するか」を決め、fire 時のみ Yui ターンを起動。
fire の prompt が Yui への発話指示になる (既存の timer.on_fire_prompt と同じ
パターンを流用)。

### コスト効果

| モジュール | 頻度 | LLM 使用 | 月コスト概算 |
|---|---|---|---|
| calendar-check | 5min | fire 時のみ (1-3 回/日) | < $0.5 |
| morning-check | 1日1回 | 毎回 (要約) | ~$0.5 |
| mail-check | 12回/日 | 差分要約 (Haiku) + fire 時 | ~$1 |
| todo-digest | 1-3回/日 | 期限超過/blocked 検出はルール、fire 時のみ Yui | < $0.5 |

合計 ~$2-3/月 で自律発話の主要部分が成立する想定。これなら 6/15 以前でも
API 課金で運用可能。

### Hot reload 対策 (Next.js dev)

`globalThis` フラグで「既に起動済み」を持ち、重複登録を防止
(`music-commands.ts` の nowPlaying と同じ pattern)。

### Active session の特定

periodic 発火時の Yui 発話は「いまアクティブな session」に push する必要がある。
session 概念は localStorage で 1 つに収束しているので、`raw_messages` の最新
`created_at` で active session を引く。

### 着手順

1. **MVP**: framework (types/registry/scheduler) + `calendar-check.ts` 1 つ ✅
2. 実運用感を見て `morning-check` 追加
3. `mail-check` (差分要約 Haiku 必要なので最後)
4. `todo-digest` (期限超過 / blocked 滞留の自律通知)

---

## 6.5 通知 (お便り) システム

結衣からの自発呼びかけを **speak (即発話)** と **notify (お便りバッジ)** の 2
系統に分け、ユーザの状態 (オンライン / 離席 / 集中) と Discord 配信を加味して
自動振り分け。朝のブリーフ・ニュース・日記など低優先の自発呼びかけが集中を破らないようにする。

### 主な仕様 (詳細は `docs/notification-system.md`)

- 振り分けマトリックス: 種別 × オンライン/離席/集中 + **Discord 列** × importance(high/normal/low)
- 効果音 3 種 (high / normal / low) + silent、volume slider 連動、集中モード中は high のみ
- **状態切替** (オンライン / 離席 / 集中) は ChatPanel ヘッダ右の pill「オンライン ▾」から手動切替
- 自動離席判定: 30 分操作なしで離席に降格 + 何か操作したらオンライン復帰
- 集中モードは **手動切替のみ、自動解除なし** (沈黙のラスト砦)
- Discord 配信は基本「離席時のみ」、集中モードは完全沈黙、朝のブリーフは常時 push
- 夜間 22-7 はサーバ側オーバーライドで一律「離席」扱い (集中は維持)
- ステータス表示: SecretaryCard のドット色 (緑=オンライン / グレー=離席 / 青=集中)
- DB: `notifications (kind, importance, title, preview, body_md, ...)` + `notification_settings (event_kind, mode_*, discord_policy, importance)`
- API: GET 一覧 / PATCH seen / POST replay / dismiss / activity / notification-settings (GET/PATCH/reset)
- SSE event: 新規 `NotificationEvent`
- **UI**: 画面左下のトースト領域 (TimerToast と同じスタック + 同じテイスト) に並べる
- **詳細閲覧**: トーストクリック → ReportPanel に body_md 展開 + Yui が一言 speak + トースト消去
- **過去履歴**: LogModal に「お便り」セクション追加 (90 日分)
- **設定 UI**: SettingsModal に「通知」タブ追加。マトリックスを per-event 編集できる
- 表記: 「通知」より **「結衣からのお便り」** を主表記 (世界観整合)

### 段階実装

| Phase | 内容 | 状態 |
|---|---|---|
| 0 (✅) | ChatPanel ヘッダ追加 (「ご主人様」+ ステータス pill UI のみ) | `966e690` |
| A (✅) | `notifications` テーブル + lib + SSE event + 朝のブリーフ/ニュース/日記を notify 化 | `48e96df` |
| B (✅) | NotificationToast (TimerToast 流用 + 同 stack) + 集中モード時の出し分け | `48e96df` |
| C (✅) | replay (Yui voice + ReportPanel push) + click で seen+dismiss / × で dismiss + LogModal「お便り履歴」 | `48e96df` |
| D (✅) | `useActivityTracker` + `/api/activity` + ステータス popover 連動 + 振り分け (speak/notify) + Discord 列 + 夜間 + 集中モード手動切替 + 解除時 Yui 一言 | `48e96df` + 解除一言追補 |
| E (✅) | `notification_settings` テーブル + SettingsModal「通知」タブ + マトリックス編集 UI + リセット | `248017c` |

**着手の目安**: 全 Phase 完了。詳細設計は `docs/notification-system.md` 参照。

### 残課題 (Phase E 完了後の audit で発見)

実装は通っているが、設計と完全一致しない / 後続対応の余地:

1. **mode = "speak" の TTS 発火** — `rule.modeOnline/Away/Focus` が "speak" のとき
   現状は "notify" と同じトースト動作。yui_message を別途 push するには既存の
   周期発話 (morning-check の fire prompt) と重複しないか整理が必要
2. **効果音 3 種 mp3** — `/public/sounds/notify-{high,normal,low}.mp3` の音源用意 +
   AudioContext で importance ごとに再生。volume slider 連動、集中時 high のみ。
   ChatPanel の chime キャッシュを流用予定
3. **mail / timer / health の発火元** — 設計マトリックス §2 には 8 種類あるが
   現状 saveNotification を呼んでるのは morning_brief / news / diary の 3 種のみ。
   - timer: 既存 timer_fired (speak) があるので、saveNotification を追加すれば履歴に残る
   - mail: mail-check periodic module 未実装。IMAP / JMAP 連携と込み
   - health: Metrics Lv4 完了後 (体調警告ルール)
4. **morning_brief の二重発火検討** — 現状 fire prompt (speak) + saveNotification
   (notify) の両方走り、Yui が朝音声で読み + トーストにも積まれる。
   設計上は notify-only だが、朝に Yui の声を聞きたい派にとっては UX が悪化する。
   オプション化 (SettingsModal「通知」タブで朝のブリーフだけ speak モード残せる)
   方向で検討。

着手順は新 audit 時の優先度で再決定。

---

## 着手順

### 実装済
- ✅ **Todos** (Wishlist + Plane 統合) — projects + tags、AI 最適化 tool、Plane 廃止済
- ✅ **Periodic framework** + `calendar-check` MVP
- ✅ **Diary** (1 日 1 エントリ、cron 自動生成、catch-up logic)
- ✅ **Contacts** (CRM + VCF import + soft delete)
- ✅ **Discord bot** (Phase F: text DM + SSE 受信)
- ✅ **画像添付** (D&D / paste / 複数枚 / 1 週間保存)
- ✅ **カラーテーマ** (6 プリセット)
- ✅ **News** (RSS 6 ソース + 1 時間 periodic + 3 日 TTL + pin 永続化 + Yui tools + UI モーダル)
  - default sources: NHK / 朝日 / ITmedia / Gigazine / Hacker News / 共同通信
  - source 追加/削除/有効無効 切替 (UI から)
  - 「このニュース保存しといて」で pinned 化 → TTL 対象外
- ✅ **Morning check** (毎朝 9:00 JST、1 日 1 回)
  - 素材: 今日の予定 + 期限近 todos + 主要ニュース 3 件 + 未読メール 5 件
  - Yui voice で SSE 配信 (web / Discord 両方)、加えて ReportPanel にも markdown 報告
  - env: MORNING_CHECK_HOUR_JST で時刻調整可
- ✅ **睡眠サポート** (Luc Beaudoin の cognitive shuffle、IconBar 羊アイコン)
  - 12 カテゴリ × ~3360 単語の image-evocative バンクから 10-20s 間隔で発話
  - 囁き ref voice + 文単位 chunk 分割 TTS で 7-15s の安定 whisper 再生
  - 結衣の今日 1 日 (会話・完了 todo・予定・日記) を素材に Sonnet で intro 生成
  - 199 式アファメーション CRUD + 10% 確率注入、Adobe Stock BGM 7 曲
  - WebAudio で PC ディスプレイスリープ越しでも timer 通り BGM 停止
  - セッション中は「集中」自動切替で通知抑止、終了で「離席」
  - 設計: `docs/sleep-support.md`、roadmap §6.6 (本セクション後出)
- ✅ **お着替え (VRM Wardrobe Phase 1)** — 複数 VRM 登録 + サムネ自動生成 + 手動切替
  - Phase 2 (walk-out/in 演出) / Phase 3 (時間帯自動切替) は将来。詳細は §6.7

### 自前構築 (次の手番)
1. **Metrics** — 健康指標・時系列数値 (体重 / BP / トレーニング PR)
2. **Periodic 拡張** — morning-check / mail-check / todo-digest
3. **Habits + Proactive** — Metrics の上に乗る能動的確認

### 見た目のカスタマイズ
4. **アバターお着替え** — Phase 1 (登録 + 手動切替) ✅ 実装済。詳細・残 Phase は §6.7 参照。
5. **カラーテーマ** — UI 全体のアクセントカラー (現状 紫 #8b5cf6) を可変に
   - 設定モーダルでプリセット (紫/桜/青/抹茶/etc) or カスタム HEX
   - CSS 変数化 (`--accent-color`, `--accent-bg`) で 1 箇所変更で全体反映
   - 結衣の人格 (おっとり) と合うパステル系プリセットを 3-5 個用意

### 6/15 以降 (Agent SDK サブスク解禁待ち)
4. **Doc Agent** — Opus 品質の自動 doc 生成
5. **Deep Research Agent** — 多段ネット探索 + 長文レポート

各フェーズで「実際に使う中で次のスキーマを再検討」する余白を残す。

---

## 6.7 お着替え (VRM Wardrobe)

### 仕様 (ご主人様要件)

- オプション > 秘書タブから **VRM モデルを複数アップロード・登録** できる
- 各モデルに **サムネ** を持たせる (一覧で見分けがつくように)
- 選び方は 2 系統 + α:
  - **手動で固定** (カードクリック → 即時切替)
  - **時間で自動お着替え** (例: 朝 casual / 昼 work suit / 夜 pajamas)
  - 起動時 fallback の「既定」モデル指定
- 着替え時の **演出**: 歩いてブラウザ外に出ていって、着替え終わったら歩いて
  戻ってくる (VRMA 必須、ご主人様が用意予定)
- 未登録時は内蔵 `public/girl.vrm` (15.5MB、git tracked) にフォールバック

### 確定設計 (Phase 1 着手時 = 2026-06-01 に固めたもの)

#### データモデル

```sql
CREATE TABLE vrm_models (
  id                 BIGSERIAL PRIMARY KEY,
  name               TEXT NOT NULL,
  filename           TEXT NOT NULL UNIQUE,         -- "<id>.vrm"
  thumbnail_filename TEXT,                          -- "<id>.thumb.png"
  file_size_bytes    BIGINT NOT NULL,
  is_default         BOOLEAN NOT NULL DEFAULT false,
  enabled            BOOLEAN NOT NULL DEFAULT true,
  uploaded_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE vrm_settings (
  id                       INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  current_model_id         BIGINT REFERENCES vrm_models(id) ON DELETE SET NULL,
  manual_override_model_id BIGINT REFERENCES vrm_models(id) ON DELETE SET NULL,
  auto_switch_enabled      BOOLEAN NOT NULL DEFAULT false,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Phase 3 で追加 (未着手):
-- CREATE TABLE vrm_schedule_rules (
--   id BIGSERIAL PRIMARY KEY,
--   model_id BIGINT REFERENCES vrm_models(id) ON DELETE CASCADE,
--   start_min INTEGER, end_min INTEGER,   -- 0-1439 (00:00 起算分)
--   dow_mask SMALLINT,                     -- 0x7F = 毎日
--   priority INTEGER NOT NULL DEFAULT 0
-- );
```

#### ストレージ

- `data/vrm-models/<id>.vrm` (60MB 上限、`.gitignore` 配下)
- `data/vrm-models/<id>.thumb.png` (2MB 上限、256x256)

#### API

| メソッド | パス | 用途 |
|---|---|---|
| GET | `/api/vrm/models` | 一覧 |
| POST | `/api/vrm/models` | upload (multipart: file + name + thumb) |
| PATCH | `/api/vrm/models/[id]` | name / isDefault / enabled |
| DELETE | `/api/vrm/models/[id]` | row + ファイル削除 |
| GET | `/api/vrm/models/[id]/file` | VRM stream |
| GET | `/api/vrm/models/[id]/thumb` | PNG stream |
| PUT | `/api/vrm/models/[id]/thumb` | サムネ差替 |
| GET | `/api/vrm/current` | 現在モデル解決 (override → current → default → null) |
| POST | `/api/vrm/current` | manual switch |

#### 切替トリガー

- カードクリック → POST `/api/vrm/current` → `window.dispatchEvent("vrm-current-changed")`
- page.tsx が listen → `/api/vrm/current` 再 fetch → `setVrmUrl` → VRMViewer の
  `useEffect [vrmaUrl, vrmUrl]` が再 run → 既存 cleanup (VRMUtils.deepDispose) →
  新 VRM ロード
- ブラウザリロード不要

#### サムネ自動生成

- アップロード時に client 側で Three.js + VRMLoader でオフスクリーンレンダ
- 顔〜胸を写す位置にカメラ (cy=1.45, cz=0.8, lookAt 1.4)、透過 PNG 256x256
- 失敗してもアップロード自体は続行 (thumb なしカード → 後で手動差替可)

### Phase 1 ✅ 実装済 (2026-06-01)

- migration `0040_vrm_models.sql` 適用済
- 上記 API 一式、`src/lib/vrm-storage.ts`、`src/lib/vrm-thumbnail.ts` 配備
- `VrmGallerySection` を `PersonaSection` 末尾に組み込み
  (秘書タブ最下部、グリッドカード UI)
- `VRMViewer` に `vrmUrl` prop + useEffect deps 追加 → 切替時に scene 再構築
- page.tsx で `/api/vrm/current` polling + CustomEvent listener + `/girl.vrm` fallback
- カード機能: 切替 (クリック) / 名前 inline 編集 / 既定設定 / サムネ差替 / 削除

### Phase 2 (将来) — Walk-Out / Walk-In 演出

**ブロッカー**: ご主人様の VRMA (`walk_out.vrma` / `walk_in.vrma`) 用意待ち

設計案:
1. 現 VRM に `walk_out.vrma` 再生 (~3s、右に歩いて画面外へ消える)
2. 画面外で透明 → 新 VRM ロード+初期化 → 画面外に配置
3. 新 VRM で `walk_in.vrma` 再生 (~3s、左から歩いて中央へ)
4. idle に復帰

実装ポイント:
- VRMA は `assets/vrma/` に置き、`public/vrma/` 経由で配信
- 全モデル共通モーション (1 ペアで使い回し)
- 演出中も chat は通常通り動作 (Yui が画面外でも応答は届く)
- 切替トリガーは Phase 1 と同じ CustomEvent → handler 内で
  「即座に scene swap」する代わりに「演出シーケンス開始 → 完了後に swap」に分岐
- 演出 ON/OFF は vrm_settings に追加 (env or DB) — 初回バグった時のためフラグで切れる
  ようにしておく

### Phase 3 (将来) — 時間帯自動切替

**前提**: Phase 1 で複数モデルが運用に乗ってから、実運用の感覚で粒度確定

設計案 (current 想定):
- vrm_schedule_rules テーブル (start_min, end_min, dow_mask, model_id, priority)
- 秘書タブ内に rule editor UI (時間帯 chip + 曜日 toggle + モデル選択)
- client 側で 1 分 polling: `/api/vrm/current` が schedule を server で評価して
  返す → manual_override が NULL の時のみ schedule に従う
- manual_override は「次の schedule 切替まで」のみ有効か「明示解除まで」永続か、
  運用してから決める

---

## 7. 内部アーキテクチャ最適化 (リファクタリング TODO)

### 7.1 scheduler / timer / music の自己 HTTP を除去して `runYuiTurn()` 関数化

**現状の問題**:
内部処理が `/api/chat` を **自プロセス自身に HTTP POST** している箇所が 4 つある。

| 呼び出し元 | 用途 |
|---|---|
| `src/lib/scheduler.ts:138` `firePromptToYui()` | periodic check (calendar-check 等) が fire 判定したら Yui ターンを起動 |
| `src/lib/timers.ts:213` `dispatchOnFireAction()` | `on_fire_prompt` 付き timer / reminder が発火した時の自動 chat |
| `src/app/api/music/now-playing/route.ts:83` `notifyYuiSongChanged()` | 曲変化通知 (Yui が 1〜2 文で曲紹介) |
| `src/app/api/music/history/replay/route.ts:74` | ノートパネルの "もう一度この曲" replay |

全部 `await fetch(\`http://localhost:${process.env.PORT ?? "3000"}/api/chat\`, { method: "POST", body: JSON.stringify({...}) })` の形。

**問題点**:
- **シリアライズ往復**: JSON encode / HTTP / JSON decode で数 ms オーバーヘッド
- **env.PORT 依存**: 起動時 PORT 違うと壊れる (devcontainer 越し等)
- **テスト困難**: 周辺ロジックの unit test に live HTTP server が要る
- **ログ二重化**: 1 つの periodic tick が 2 つの request log を残す ("[scheduler] FIRE..." と "POST /api/chat 200")
- **同プロセス内なら関数呼び直接でいい**: events.ts のコメントにも「Node monolith 前提」と既述。Discord bot 側のクロスコンテナ HTTP 境界は別議論 (それは正しい)。

**やること**:
1. `src/app/api/chat/route.ts` の `POST(req)` 関数本体を `runYuiTurn(opts: TurnInput): Promise<TurnOutput>` として export。`POST` は body parse → `runYuiTurn` → `Response.json` の薄い wrapper になる。
2. `TurnInput` 型: `{ messages, sessionId, source, suppressTTS?, ... }` 等、現在 body から拾ってる値を引数化。
3. `TurnOutput` 型: `{ reply, emotion, sessionId, memoryCounts, pendingJobs, toolSummary }` (現在の Response.json の payload と同じ)。
4. 上記 4 つの caller を `fetch(...)` から `runYuiTurn({...})` 直呼びに置換。
5. Discord bot (`apps/discord-bot/src/index.ts`) の HTTP は **そのまま残す** — 別コンテナの境界はメリットがあるので。

**リスク・注意**:
- `route.ts` は 2000+ 行。POST handler は body parse → memory retrieve (L2/L3/L4) → environment block → tools 構築 → main LLM loop → tool dispatch → reply 生成 → raw_messages 書き込み → SSE push (cron source 用) → 統計ログ という長いパイプライン。型を綺麗に切り出すには丁寧な設計が要る。
- 切り出すなら同時にこの長い手続きを段階関数に分解する誘惑があるが、**スコープを runYuiTurn 切り出しに限定** すること。それ以上は次のリファクタ機会で。
- 切り出し後の動作確認: web から 1 ターン / Discord bot から 1 ターン / timer 発火 / 曲変化通知 / periodic fire を全部叩いて regression が無いことを確認。

**着手の目安**:
別セッションで丁寧に。1〜2 時間枠を取る。手をつけたら最後まで終わらせる (中途半端なコミットは route.ts の動作不能リスク)。

### 7.2 SSE event 型を web と Discord bot で共有

**現状の問題**:
- `src/lib/jobs/events.ts:12-86` に `ServerEvent` union 型 (yui_message / timer_fired / report_update / music_command / job_status) がある
- `apps/discord-bot/src/sse.ts:8` は独自に `SseEvent = { name: string; data: unknown }` で受信、handler 側で `(d as Record<string, unknown> & { type?: string })` キャストしてフィールドアクセス
- 新しい event 種を web で追加しても bot 側に型情報が伝わらない (silent drift)
- `pushToSession` が全 event を全 subscriber に送るので、Discord bot は client 側で `if (type === "yui_message" || type === "timer_fired")` フィルタしてる

**やること**:
1. `src/lib/jobs/events.ts` の event 型を共有モジュールに切り出すか、bot の tsconfig で `paths: { "@yui/events": ["../../src/lib/jobs/events"] }` 設定して直 import 可能に
2. bot の `handleSseEvent` を typed union switch にし、`unknown` キャスト消す
3. `pushToSession(sessionId, event, audience?: "web" | "discord" | "all")` で publisher 側に audience hint を渡す案を検討 (subscribeSession で filter 引数を取る方が綺麗かも)
4. 既存の「曲変化通知は web のみ」のロジック (now-playing/route.ts の source=web フィルタ) を audience field に統一できるか

**リスク・注意**:
- bot の build は完全独立 (apps/discord-bot/ 内で `npm install` 完結)。共有 path 設定が docker-compose のマウントと整合する必要あり
- 単純 path import なら docker-compose で `..:/parent` マウントが要る (今はやってない)。代替案: ビルド時に `cp` でコピー、もしくは shared 型を npm workspace 化

**着手の目安**: 30〜60 分。route.ts ほどリスクは無いので軽く着手可。

### 7.3 Periodic Module の cron schedule 実装 + runOnce admin route

**現状の問題**:
- `src/periodic/types.ts:21` に `PeriodicSchedule = { kind: "interval"; everyMs } | { kind: "cron"; expr }` の union 型はあるが、`cron` は scheduler.ts:47-50 で `console.warn("cron schedule not yet supported, skipping")` で実装無し
- `diary-write` は本来「JST 23:00」cron 表現したいのに、5 分 interval + run 内で時刻判定する作りになってる
- 開発中に「今この periodic を動かしたい」時、setInterval を待たないと発火しない

**やること**:
1. cron 評価 (croner や cron-parser を npm install) → `src/lib/scheduler.ts` の `setInterval` パスとは別に「次の発火時刻まで setTimeout → 発火 → 再計算」の chain で実装
2. `POST /api/periodic/runOnce` admin route 追加: body に `{ moduleId }` 取って `tick(mod)` を即実行
3. `diary-write` を cron 表現 (`0 23 * * *` 等) にできるが、catch-up logic は残す

**リスク・注意**: 軽量、ローカル単一プロセスなのでロックや排他考慮不要

**着手の目安**: 次の periodic module (morning-check / mail-check) を足したくなった時。それまでは現状の 5 分 interval で十分。

### 7.5 リップシンクのずれを完全に治す — 高優先

**現状の問題**:
- TTS audio の再生と viseme (口パク) のタイミングがわずかにずれる
- いいね機能 (VRM ダブルクリック) の実装で初めて顕在化。通常 chat でもずれているが、ユーザはアバターを注視していなかったので気付かなかった
- 「口パクが始まってから音声が来る」「終わったあとも音が少し聞こえる」等、システム/環境依存で方向が変わる

**現状の実装** (`src/components/ChatPanel.tsx` `playBuffer` + `src/components/VRMViewer.tsx`):
- ChatPanel の `playBuffer` で `source.start()` と同時に `audioBridge.current.speaking = true` + CustomEvent `yui-lip-sync-start` を dispatch
- VRMViewer 側は `bridge.speaking || forceLipSyncRef.current` で viseme animation を駆動 (analyser があれば RMS、なければ sinusoidal mock)
- `source.onended` で speaking を false + CustomEvent `yui-lip-sync-end` を dispatch (最新 source のみ)
- 一度 `AudioContext.outputLatency` ベースの setTimeout 補正を入れたが、ブラウザ実装が信頼できず逆効果 → 撤回済

**仮説 (どれが効くか実測で切り分け)**:
1. `AudioContext.outputLatency + baseLatency` のシステム遅延 (Bluetooth/USB DAC では 100ms+) が支配的
   - 対策: 信頼できる場合は補正、できない場合はユーザに device 切替を促す UI
2. AnalyserNode の RMS smoothing factor (`delta * 25` の補間) で口の動きが少し遅れる
   - 対策: smoothing を緩めるか、look-ahead で 1 フレーム先読み
3. VRMViewer の frame loop は requestAnimationFrame 駆動なので 16ms 単位のずれ
   - 対策: visemes の transition rate を上げる
4. `dispatchEvent` → React state propagation → frame loop で読む、までに 1 フレーム遅れ
   - 対策: forceLipSyncRef は ref なので即時反映するはず、検証必要
5. **本質対策**: テキスト → phoneme → viseme の sequence を生成し、AudioBuffer の duration に合わせて先に schedule。analyser RMS ベースを廃止して deterministic に
   - 日本語 phoneme 推定は kuromoji.js 等で軽量に可能
   - 各 viseme の onset/offset を `AudioContext.currentTime` ベースで scheduling

**着手アプローチ案**:
1. **計測フェーズ**: DevTools Performance + AudioContext の各 latency 値を実機 (Mac 内蔵 / BT / 外部 DAC) で記録、ずれの大きさと方向を定量化
2. **対症フェーズ**: outputLatency 補正を opt-in で復活 (env or setting で ON/OFF)、ユーザ環境ごとに調整可
3. **根本フェーズ**: phoneme-based viseme scheduling に移行
   - text を kuromoji で形態素 → モーラ → viseme key 列に変換
   - audio duration を `audioBuffer.duration` から取得、モーラ数で均等割り
   - `AudioContext.currentTime` + offset で各 viseme の peak を schedule
   - analyser ベース駆動は廃止 or fallback として残す

**ディテール重要度**: ⭐⭐⭐ — アバター注視時の没入感を支配する要素。長期的には完璧に治したい

**着手の目安**: 他の機能追加が一段落した頃。または「アバターお着替え」「カラーテーマ」と並んで「見た目改善」フェーズで一緒に対応。phoneme 化は kuromoji 依存追加 (要承認、bundle size 数 MB) になるので Yes/No 判断が必要。

### 7.6 レベルアップ演出 (秘書カード Lv 機能の拡張)

**前提**: Phase 2 で xp_events + 加算 hook が走り、SecretaryCard で Lv を表示するようになる。XP が次レベル閾値を跨いだ瞬間を server-side で検出できる。

**今すぐ実装する基本**:
- SSE stats_update event の delta に `levelUp: { from, to }` を含める
- SecretaryCard でカード自体を 1.5 秒フラッシュ + Lv バッジに pulse animation

**将来的に増やしたい演出案**:
1. **Yui の特別発話** — 「Lv X になりました。ご主人様のおかげです」等、自動で固定セリフを TTS 経由で発話 (ハート反応の HEART_LINES と同じ仕組み)。Lv の桁が変わる時 (10 / 20 / 30) は専用ライン
2. **VRM の特別ジェスチャ** — VRMA アニメで小さく拍手 or お辞儀。3D アニメは Blender 必要なので Phase B
3. **画面エフェクト** — ハート粒子と別系統のキラキラ / 紙吹雪 / 光のリング。HeartBurst.tsx と同じ pattern で `LevelUpBurst.tsx` 新規
4. **chime 音** — `/sounds/level-up.mp3` を 1 つ仕込む (短く上品なベル音)。volume slider 連動
5. **chat に system message として残す** — 「Lv X に上がりました」を assistant 行として残し、後でログ振り返り可
6. **節目ごとの reward 解放** — Lv5: 衣装色変更、Lv10: 新表情、Lv20: 新 VRM model、等 (アバターお着替え機能と統合)

**ディテール重要度**: ⭐⭐ — 長期育成感の核心、Lv 上がってもただ数値が変わるだけだと味気ない

**着手の目安**: SecretaryCard の基本実装が落ち着き、ご主人様が「Lv 2-3 まで上がってきた」と感じる頃。最初は (1) 発話 + (3) エフェクト + (4) chime の 3 点セットで十分

### 7.7 秘書カードのステータスドット拡張

**現状**: SecretaryCard 左上のステータスドットは `sc-status-ok` (緑グロー) で固定表示。CSS には `sc-status-warn` (黄) / `sc-status-error` (赤) クラスも用意済だが未連動。

**やりたいこと**:
1. システム状態 (LLM 失敗連発、Discord bot down、Anthropic 5xx 多発、Postgres unreachable 等) を server-side で検出し、SecretaryCard に SSE event `status_change` で push
2. クライアントはステータスドットの class を切り替え (sc-status-ok / warn / error) + ホバーで原因をツールチップ表示
3. ドットを click → LogModal を `errors` フィルタ付きで自動で開く (LogModal は既存)
4. エラー解消で自動的に緑に戻る (resolved push)

**シグナル元の候補**:
- LLM call の連続失敗 (例: 直近 5 分で error 率 > 50%)
- Discord bot の SSE heartbeat 断
- DB connection error (Postgres pool exhausted 等)
- 朝のブリーフィングが時間内に発火しなかった (scheduler 健全性)

**ディテール重要度**: ⭐ — 普段使いでは見えないが、何か起きた時の発見性が上がる

**着手の目安**: 上記シグナル元の中で「今気にしたいもの」が出てきた時。最初は LLM 失敗率だけで十分

### 7.8 TTS 前処理パイプライン (= 朗読品質の底上げ)

**現状の問題**:
- IrodoriTTS (LFM 系) は英語・記号にとても弱い。例:
  - 「5/28(水)」が「ごぶんのにじゅうはちカッコすいカッコ」みたいに崩れる
  - 「Apple Music」「Discord」など固有英語が意味不明な発音に
  - 数字 + 単位 (12kg, 70℃) も読み崩れる
- 日記読み上げ、朝のブリーフィング、ハート反応のセリフ、すべてに影響している
- ご主人様の発案: 読み上げる前に **LLM で 1 度フィルタを通して、記号削除 + 英語 → カタカナ + 数字記号の自然読みに正規化**

**やること (パイプライン)**:
1. **正規化関数** `normalizeForTTS(text): Promise<string>` を新設
   - Haiku 4.5 (安い・速い) で 1 ターン処理
   - in/out で 1:1 対応 (要約しない)、文意は変えない
   - 改行・空行は保持
   - **プロンプト要件** (ご主人様の発案を踏まえて):
     - 記号は読み上げに自然な日本語に置換 (`/` → 文脈次第で「の」または省略、`→` → 「やじるし」または省略、`()` → 文意を切る助詞に等)
     - 英単語はカタカナ表記 (固有名詞は一般的な発音、技術用語も同じ)
     - 数字 + 単位は自然な読みに展開 (`12kg` → 「じゅうにキログラム」、`70℃` → 「ななじゅうど」)
     - **文脈に応じて読みづらい漢字を ひらがな に書き換える** — TTS が誤読しやすい代表例:
       - `○○の方` が「ほう」(方法/方向の意) を意味するなら **「○○のほう」** に書き換え (TTS は「かた」と読みがち)
       - `一日` は文脈で「いちにち」or「ついたち」、対応する読みに展開
       - `今日`/`明日`/`昨日` も TTS によっては読み崩れるのでひらがな化
       - `日付` 表記 (`5/28(水)` 等) も「ごがつにじゅうはちにちすいようび」のような自然読みに
       - その他、同形異音語 (例: `人気` のひとけ/にんき) は文意から判断してひらがな化
     - 全体として「音声で読まれて自然に伝わるか」を判定基準にする
2. **キャッシュ**: 同一入力テキスト → 同一出力なので Map に LRU cache (chunk 単位、数十 MB 程度許容)
3. **適用箇所**:
   - 日記読み上げ (DiaryModal の `__yuiSpeakText` 突入直前)
   - ハート反応セリフ (固定テキストなので一度正規化して定数化でも可)
   - 朝のブリーフィングの Yui voice (cron 経由なので生成側で対応)
   - 通常チャット応答も (品質改善になる、ただし latency 数百 ms 増えるので opt-in も検討)
4. **ストリーミング正規化** (本朗読のため):
   - chunk N を再生中に N+1 を `normalizeForTTS` → TTS decode の二段先読み
   - ラグ最小化

**コストとレイテンシ見積**:
- Haiku 4.5: $1/1M input, $5/1M output
- 日記 1 件 (200-400 字) なら $0.001 未満、レイテンシ 0.5-1.5 秒
- 本 1 章 (10K 字) なら $0.05 程度、cache に乗れば 2 回目は無料
- 連続朗読中は次 chunk を先読みするので体感ラグなし

**着手の目安**: 本朗読 (7.9) を始める前に必須。日記読み上げ品質改善も兼ねるので
単独でも価値あり、Lv1 (= 日記専用) で先行投入もアリ。

### 7.9 本の朗読機能

**前提**: 7.8 (TTS 前処理) が必要。なくても可動するが品質が低い。

**やること**:
1. **取り込み**
   - TXT (簡単) → EPUB (zip + xhtml、`epub.js` などで容易) → PDF (重い、後回し)
   - アップロードで `data/books/` に保存、本文 normalize → 章 / 段落 chunk 配列を保存
2. **DB スキーマ**
   ```sql
   CREATE TABLE books (
     id BIGSERIAL PRIMARY KEY,
     title TEXT NOT NULL,
     author TEXT,
     file_path TEXT NOT NULL,
     total_chunks INT NOT NULL,
     created_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   CREATE TABLE book_chunks (
     book_id BIGINT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
     chunk_idx INT NOT NULL,
     chapter_title TEXT,
     raw_text TEXT NOT NULL,
     normalized_text TEXT,         -- TTS 前処理結果のキャッシュ
     PRIMARY KEY (book_id, chunk_idx)
   );
   CREATE TABLE book_bookmarks (
     book_id BIGINT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
     last_chunk_idx INT NOT NULL DEFAULT 0,
     updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
   );
   ```
3. **UI (BooksModal)**
   - 本棚 (本一覧、進捗バー、最終再生日時)
   - 朗読ビュー (現在 chunk + 前後ハイライト + ▶/⏸/⏭/⏮ + 章移動)
   - 「次の章へ」「目次から飛ぶ」
4. **再生パイプライン**
   - 既存 `__yuiSpeakText` をベースに、chunk を 1 つずつ `normalizeForTTS` → TTS decode → 再生
   - 進んだ位置を `book_bookmarks.last_chunk_idx` に書き戻し
   - 中断・再開で同じ位置から続く
5. **オプション (Lv 2)**
   - **睡眠タイマー**: 30/60 分後に自動停止
   - **章要約**: Yui に「ここまでの章を要約して」と頼める tool 化
   - **読了後の感想日記**: 朗読完了後に Yui が自動で日記に「『○○』を読み終わりました」と書く
   - **Project / Todo 連動**: 「読了する」を todo に登録 → 朗読完了で自動 done
   - **キャラ別朗読**: 地の文 = Yui、台詞 = 別音色 (現状の IrodoriTTS は単一声なので将来 TTS 拡張時)

**着手の目安**: ご主人様が「読みたい本がある」と思った時。7.8 を先に投入してから。

---

## 8. Yui Coding Mode + 個人用シェル (低優先・たぶん未実装)

ご主人様が日常的にコーディング作業をするため、Yui の窓内から `claude` / `codex` /
通常 shell を起動できると 1 画面で完結できる、というアイデア。

### 8.1 立て付け

**一般公開しない理由**: web shell は何でもできてしまうのでセキュリティが本質的に
怖い。Docker sandbox 内に閉じても、ホストの mount を緩く設定したらホスト側にも
飛び火する。「個人がセルフホストして自分のためだけに使う」前提でのみ成立する。

→ **デフォルトは無効**、`env SHELL_ENABLE=true` でのみ有効。docs にも「外部公開する
   構成では絶対に有効にするな」を明記する。

### 8.2 二段階構想

#### 8.2a 単純シェル (Plain Shell)
- `xterm.js` + `xterm-addon-fit` をフロントに
- バック: `node-pty` で擬似端末、WebSocket で双方向 stream
- IconBar に新 SHELL icon (lucide terminal)、もしくは設定 > 開発者ツール tab に隠す
- shell の cwd は **専用コンテナ内のみ** (web コンテナ自体の bash を渡さない)
- 起動時に dropdown で「どのプロジェクト dir で開くか」選択 (project ごとに dir 分離)

#### 8.2b Yui Coding Mode (本命)
Yui の人格 (結衣) のまま、**コーディング中は真面目モード** に切り替える。
- 通常: お嬢様口調・ふふっ・はーい
- コーディング中: 「現在の差分: ... テストは X 件失敗です。原因はおそらく…」のように
  Claude Code と同じ温度で論理を出す。声色 / TTS の whisper / 表情だけ Yui のまま
- mode 切替は明示的に: 「コーディングモード開始」「ご主人様、お疲れさまでした」で離脱
- ユーザ Yui へ「ここの bug 直して」→ Yui が裏で `claude` / `codex` 起動して回す ↔
  進捗を Yui の口から報告

#### 8.2c プロジェクト管理
- 各 project に `code_dir` (= 例 `/workspaces/<project-slug>`) を紐付け
- shell も coding agent もこの dir 内に閉じる
- `CLAUDE.md` を Yui が自動生成: project の `description` + `todos` + `diary` から
  「このリポジトリは何のためのもので、最近何を作業中か」を要約して書き込み
- Claude Code / Codex はこれを最初に読み込んで context を持つ → 説明し直しが減る

### 8.3 セキュリティ設計 (最低限)

- shell コンテナはホスト fs にアクセスできない (volume mount しない)
- network も project に必要なものだけ (npm registry, github 等) に絞る
- exec ログを LLM event と同じ要領で `shell_events` に audit ログ
- 「rm -rf /」「sudo」「curl ... | sh」等の危険コマンドは検出時に警告 (block はしない)

### 8.4 着手判定

- 現状 ご主人様は通常の terminal で claude code を回しており、強い不便は無い
- 統合する旨味は「Yui が project の進捗を読める」「報告ループが 1 ウィンドウ」
- セキュリティ設計を真面目にやると工数大 → **当面は記録だけ、実装は遠い**
- 本気で要るとなったら、まず 8.2a (単純シェル) を 1 日で出して評価 → 良ければ 8.2b 設計

---

## 9. 道案内 / ルート計算 (Phase 1 実装済 / Phase 2 駅すぱあと待ち)

「○○まで何分?」「乗換教えて」を Yui に聞いた時、tool 無しで LLM が幻覚で答える問題
(= 2026-06-03 渋谷 → 末広町 で乗換 3 回案内された) を解消する。詳細は
[`docs/routing-guidance.md`](routing-guidance.md)。

### 現状 (Phase 1 ✓)
- **driving / walking**: Google Routes API で構造化取得 (= 所要時間 / 距離 / 混雑判定)
- **transit**: JP データは Google が server-side 非公開のため、**Google Maps deep
  link を返す fallback** (= ご主人様がクリックして実 transit を確認)
- 設定 > 連携 タブで Google Maps API key を管理 (= integration_settings)

### Phase 2 (= 駅すぱあと スタンダード 90 日無料評価有効化後)
- transit を構造化 JSON で取得 (= 駅すぱあと API)
- `lib/routing.ts` の transit 分岐を Google Maps URL → 駅すぱあと に差し替え
- formatter は構造化があれば自動でリッチ表示に切替 (= 既存 RouteSummary 型でそのまま)
- 90 日評価後に従量制本契約 (= 個人利用月 150-600 req 想定、数百円見込み)

### Phase 3 (任意) — マップ視覚化
- ReportPanel に Google Static Maps の経路画像
- Yui voice + 視覚的な地図

---

## 10. Capacitor ネイティブアプリ (= phone-native 機能のため)

外出中の HealthKit 自動同期 / GPS / iOS push 通知を実現するため、Web を WebView で
ホストする Capacitor iOS アプリを作る。詳細は [`docs/capacitor-app.md`](capacitor-app.md)。

### 構成
- 既存 Web (VRM / Chat / 設定 / ヘルス画面) を **100% 再利用** (= WebView)
- ネイティブ機能は Capacitor Plugin 経由:
  - Geolocation (background)
  - HealthKit (= iOS Shortcut 経路を廃止)
  - PushNotifications (APNs)
  - Biometric ロック
- サーバ側は既存 endpoint (`/api/health/import` / `/api/location`) を流用、
  `push_devices` テーブルだけ新規

### 実装フェーズ (合計 3-5 日)
1. Capacitor 雛形 + WebView 表示 (半日)
2. Geolocation + HealthKit (1 日)
3. Push 通知 (1-2 日、APNs auth key 発行込み)
4. Polish + TestFlight 配布 (1 日)
5. (任意) リマインダー → iOS push 連携

### 着手タイミング
**2026-06-15 以降の比較的早い時期**。VRM の WebView パフォーマンス検証が要るので、
最初の半日で動作確認 → 続行判断。

