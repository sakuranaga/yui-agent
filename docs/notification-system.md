# 通知 (お便り) システム 設計書 v2

> **改訂履歴**
> - **v1** (= 2026-05-30 commit `48e96df`「Notification (お便り) system Phase A-D」)
>   で実装。speak / notify / silent の 3 値 mode、9 eventKind、夜間 22-7 JST
>   ハードコード オーバーライド。
> - **v2** (本書、2026-06-08): 約 1 週間の運用で複数の壊れ箇所が発見されたため、
>   fact ベースの監査結果に基づいて全面改訂。詳細は §1。

---

## 0. 本書の位置付け

v1 設計書を書いた後、実装の各経路で **設計と実装の乖離** が複数発見された:

- mail 通知がそもそも発火経路に組み込まれていなかった
- schedule (= 予定 5 分前リマインド) が `notification_settings` の参照を bypass し、設定 UI から無効化できない
- schedule で**終日 event を 0 時前に「3 分後に始まります」と告げる** バグ (= 終日除外 filter が無い)
- news が独自 throttle で mode 決定し、`notification_settings.news` の rule を参照しない
- timer / diary も `getRule()` を呼ばない (= 設定 BYPASS)
- mode が 3 値 enum (`speak / notify / silent`) のため、**「toast 出さず speak だけ」** の組み合わせが表現不可
- 夜間 22-7 オーバーライドが UI に存在せず、ハードコード時刻が時差勤務 / 育児 / 昼寝主体の user に逆効果

本 v2 はこれらを **個別 hotfix ではなく構造的に解決** する再設計。マトリックス UI のセル増加 / schema migration / dispatcher 統一インターフェイス / quiet hours UI 化を含む。

---

## 1. 監査結果 (= v1 実装の現状、fact)

### 1.1 saveNotification 呼出箇所 (= 全 4 箇所)

| ファイル | 行 | kind | getRule 参照 | modeOverride |
|---|---|---|---|---|
| `src/periodic/news-fetch.ts` | 116 | `news` | **NO** (自前 throttle で mode 決定 → modeOverride で強制) | あり |
| `src/periodic/morning-check.ts` | 154 | `morning_brief` | YES (= 行 184-188) | なし |
| `src/periodic/diary-write.ts` | 65 | `diary` | **NO** | なし |
| `src/periodic/reminder-dispatch.ts` | 65 | `reminder` | YES (= 行 33-40) | なし |

→ **9 eventKind 中、saveNotification 経由で発火しているのは 4 種類のみ。** mail / music / schedule / health / timer は別経路 or 未実装。

### 1.2 別経路で発火しているもの

| eventKind | 経路 | 設定参照 | 備考 |
|---|---|---|---|
| `music` | `src/lib/music-commands.ts:159` の `notifyYuiSongChanged()` → 内部 `/api/chat` POST | YES (= 行 234-240) | saveNotification は通らない。speak fire のみ、toast は出ない |
| `timer` | `src/lib/timers.ts:193-220` の `fireNow()` → SSE `timer_fired` + raw_messages | **NO** | timer は専用 toast (`TimerFiredToast`) で表現、お便り経路は別 |
| schedule (= calendar) | `src/periodic/calendar-check.ts:79-95` → `fire: { prompt }` | **NO** | `EventKind` 列挙にも未登録 |
| `mail_important` / `mail_other` | **発火経路なし** | — | `notification_settings` にデフォルト行はあるが、saveNotification 呼び出しが存在しない |
| `health` | **発火経路なし** | — | 同上 |

### 1.3 schedule (= calendar-check) の終日 event バグ (= fact)

`src/periodic/calendar-check.ts:17-21`:

```ts
function eventStartMs(e: CalEvent): number {
  if (e.start.dateTime) return new Date(e.start.dateTime).getTime();
  if (e.start.date) return new Date(e.start.date + "T00:00:00+09:00").getTime();
  return NaN;
}
```

→ 終日 event (`e.start.date` のみ存在) は `00:00:00 JST` として時刻化される。23:55 の polling tick で「5 分後 ± 2.5 分」の window に翌日 0:00 のイベントが入り、「3 分後に予定『東京外苑キャンパス休館日』が始まります」と告げてしまう (= ユーザー報告事例)。

filter (行 59-63) は `Number.isFinite(startMs)` しか見ていないので、終日除外なし。

### 1.4 news mode 決定ロジック (= fact)

`src/periodic/news-fetch.ts:80-87`:

```ts
const lastSpokenMs = settings.lastSpokenAt ? settings.lastSpokenAt.getTime() : 0;
const throttleMs = settings.minSpeakIntervalHours * 60 * 60_000;
const inThrottle = lastSpokenMs > 0 && now - lastSpokenMs < throttleMs;
const mode: "speak" | "notify" = inThrottle ? "notify" : "speak";
```

→ ユーザーが `notification_settings.news.modeOnline = "speak"` に設定しても、`lastSpokenAt` から `minSpeakIntervalHours` 経過していなければ強制的に `"notify"` (= toast のみ) になる。throttle 設定は `news_curation_settings` 側にあり、通知設定 UI とは別。**「speak 設定なのに toast しか出ない」体感の正体**。

### 1.5 saveNotification 内部の toast / speak バインド (= fact)

`src/lib/notifications.ts:121-159` を要約すると:

| mode | toast (= SSE notification event push) | speak (= yui_message push) | overlay tee |
|---|---|---|---|
| `silent` | ✗ | ✗ | ✗ |
| `notify` | ✓ | ✗ | ✗ |
| `speak` | ✓ | ✓ | ✓ (kind=ephemeral) |

→ **speak は必ず toast を伴う**。「speak だけして toast 出さない」は v1 では不可能。

### 1.6 EventKind と NotificationKind の不整合

```ts
// notification-settings.ts:15-24
export type EventKind = "timer" | "morning_brief" | "diary" | "news"
  | "mail_important" | "mail_other" | "music" | "health" | "reminder";

// notifications.ts:17-25
export type NotificationKind = "morning_brief" | "news" | "diary" | "mail"
  | "health" | "timer" | "custom" | "reminder";
```

→ `mail` (NotificationKind) vs `mail_important` / `mail_other` (EventKind)、`music` (EventKind だが NotificationKind には無い)、`custom` (NotificationKind だが EventKind には無い) — **2 つの enum が同期していない**。`saveNotification` が `input.kind as EventKind` でキャストして `getRule` を呼ぶので (= notifications.ts:93)、`kind=mail` で呼ばれた場合 `EventKind` には無い値で getRule され、結果として `DEFAULT_RULES[0]` (= timer の rule) に fallback (= notification-settings.ts:157)。事実上 **mail 用 rule は使われていない**。

### 1.7 監査サマリ

| # | 問題 | 影響 | 規模 |
|---|------|------|------|
| **A** | mail 通知未実装 (saveNotification 呼出 0) | 設定マトリックスにあるのに動かない、user 体感「メール何も来ない」 | 中 (= dispatcher 新規実装) |
| **B** | schedule が EventKind に未登録 + 設定 BYPASS | 「予定通知は設定で抑制不可」「終日 event を 0 時前に通知」 | 中 (= EventKind 追加 + calendar-check 改修) |
| **C** | news の throttle と rule の二重ロジック | 「speak 設定なのに toast しか出ない」体感 | 小〜中 (= 統合判定に書き換え) |
| **D** | timer / diary が設定 BYPASS | timer は別 UI 経路なので影響小、diary は user 不在で通知不可能 | 小 |
| **E** | 健康通知 (health) 未実装 | DEFAULT_RULES にあるが発火元なし | 中 (= 発火元設計から要) |
| **F** | mode 3 値 enum で toast/speak 独立不可 | 「toast だけ」「speak だけ」が選べない | 大 (= schema 変更) |
| **G** | 夜間 22-7 ハードコード + UI 無し | 「online のはずなのに silent」体感、時差ユーザー逆効果 | 中 (= UI + schema + activity.ts) |
| **H** | EventKind と NotificationKind の不一致 | mail kind で rule 取り違え (= timer rule にフォールバック) | 小 (= enum 統一) |
| **I** | DEFAULT_RULES に `schedule` 行が無い | 上 B の前提 | 小 |

---

## 2. v2 の設計方針

監査結果を踏まえ、以下を柱とする:

### 2.1 mode taxonomy を 2 軸に分解 (問題 F)

`Mode = "speak" | "notify" | "silent"` の単一 enum を廃止し、**toast と speak を独立 boolean** に分ける。

| toast | speak | 旧 mode との対応 | UI ラベル (= 表示用) |
|-------|-------|-----------------|---------------------|
| ✗ | ✗ | silent | 「何もしない」 |
| ✓ | ✗ | notify | 「お便りだけ」 |
| ✗ | ✓ | (v1 では不可能) | 「読み上げだけ」 |
| ✓ | ✓ | speak | 「お便り + 読み上げ」 |

これで 4 通り全部 expressible。Web の toast と Yui の発話 が完全に独立。

実装上は per-state で 2 列ずつ (= `toast_online`, `speak_online`, `toast_away`, ...) を持つ。

### 2.2 全 dispatcher を統一インターフェイス経由に (問題 A-E)

新しい `dispatchNotification(input)` 関数を `src/lib/notifications.ts` に追加し、**toast / 履歴 / rule 判定の入口をこれ 1 つに集約** (= speak fire の動的経路は music / schedule のように残るケースあり、後述):

- DB 永続化は **常に行う** (= 履歴は残す。silent でも DB には書く)
- getRule → state → toast / speak 判定 → 独立 fire
- modeOverride は廃止 (= news の throttle は内部で `enabled` flag に変換、§4.3)
- mail / schedule / health は dispatchNotification 経由

**music / schedule は同一パターンで分離** (= 動的 speakText を要するため):
- **toast / 履歴は dispatchNotification 経由** (= 統一化)
- **speak は既存の動的 fire 経路を維持**:
  - music: `notifyYuiSongChanged` 内部 `/api/chat` fire (= 曲ごとの trivia 込み)
  - schedule: calendar-check.ts の `fire: { prompt }` → scheduler 経由 `/api/chat` (= 動的予告文)
  - 静的 `speakText` では表現力不足、Yui に動的生成させる
- 重複 speak 防止: dispatchNotification 側は両者とも `skipAutoSpeak: true` で speak 抑制
- 設定参照: 各 dispatcher 側 (= `notifyYuiSongChanged` / calendar-check.ts) で `rule.speakFor(state)` を見て fire 判定 (= speak=false なら fire しない、§4.4 表参照)

### 2.3 EventKind と NotificationKind を統合 (問題 H)

`NotificationKind` を廃止し、**`EventKind` を single source of truth** にする。`saveNotification.kind` は `EventKind` 型に強制。`mail` → `mail_important` / `mail_other`、`custom` は廃止 (= 既存使用箇所無し)、`music` / `schedule` 追加。

### 2.4 schedule を first-class EventKind に + 終日 filter (問題 B, I)

`EventKind` に `"schedule"` を追加し、`DEFAULT_RULES` にもデフォルト行を追加。`calendar-check.ts` を改修して:

- 終日 event (`e.start.date` のみ) を filter で除外
- `dispatchNotification({ kind: "schedule", ... })` 経由に変更 (= 設定参照あり)

将来「終日 event も知らせたい (= 朝に一括)」需要が出たら別 module で `schedule_allday` kind を作る (= スコープ外)。

### 2.5 mail を実装 (問題 A)

`src/periodic/mail-poll.ts` の末尾、score 閾値超え後に `dispatchNotification({ kind: "mail_important" | "mail_other", ... })` を呼ぶ。

- important 判定: 既存の mail classify (= `mail_curation_settings` の重要送信者 list) を流用
- preview: subject のみ (= プライバシー §16 維持)
- bodyMd: 件名 + from + 短い snippet (= DB 内部表示用、外部送信なし)

### 2.6 health を **保留** (= 別 Phase に切り出し)

DEFAULT_RULES には残すが、発火元設計が必要なので v2 本体では実装しない。Phase G+ で別途。

### 2.7 quiet hours UI 化 (問題 G)

夜間 22-7 ハードコードを撤廃し、`quiet_hours_settings` テーブル + UI トグルに置換。**デフォルト OFF**。詳細 §11.

### 2.8 timer は現状維持 (= 設定 BYPASS のまま意図的)

timer は独自の `TimerFiredToast` UI (= 既存) で十分。お便りバッジに混ぜると Toast スタックが汚れる。設定 UI からも timer 行は外す。

---

## 3. 振り分けマトリックス (v2 デフォルト)

新 mode taxonomy 採用。表記は **`[toast / speak]`** で each state ごとに。

| 発火元 | オンライン | 離席 | 集中 | importance | Discord |
|---|---|---|---|---|---|
| 朝のブリーフィング | ✓ / ✗ | ✓ / ✗ | ✓ / ✗ | normal | 常時 push |
| 日記生成完了 | ✓ / ✗ | ✓ / ✗ | ✓ / ✗ | low | 離席のみ |
| ニュース新着 | ✓ / ✓ | ✓ / ✗ | ✓ / ✗ | low | 離席のみ |
| **メール (重要送信者)** | ✓ / ✓ | ✓ / ✗ | ✓ / ✗ | high | 離席 push |
| **メール (それ以外)** | ✓ / ✗ | ✓ / ✗ | ✓ / ✗ | normal | 離席のみ |
| 音楽トラック切替 | ✗ / ✓ | ✗ / ✗ | ✗ / ✗ | low | 配信なし |
| **予定 (= schedule、終日除く)** | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | high | 離席 push |
| **メール脅威 (= mail_threat、将来 Phase G1)** | ✓ / ✓ | ✓ / ✓ | ✓ / ✓ | high | 常時 push |
| リマインダー | ✓ / ✗ | ✓ / ✗ | ✓ / ✓ | normal | 離席 push |
| (体調 / 健康警告 — 将来 Phase) | — | — | — | — | — |

凡例:
- `✓ / ✗` = toast 出す / 読み上げしない (= 旧 "notify")
- `✓ / ✓` = toast 出す + 読み上げする (= 旧 "speak")
- `✗ / ✓` = toast 出さない + 読み上げのみ (= **v2 新規**、音楽トラック紹介などに使う)
- `✗ / ✗` = silent

**timer は表から外す** (= 独自 UI、設定対象外)。

例外メモ:
- **音楽トラック切替** は `toast=✗ / speak=✓` がデフォルト (= 邪魔にならないけど声で曲名は教えてほしい、という典型的ニーズ)
- **予定** は `speak=✓` をデフォルトに (= 5 分前の予告は声でほしいケースが多い)。終日は filter で発火しない

---

## 4. 統一 dispatcher インターフェイス

### 4.1 関数シグネチャ

`src/lib/notifications.ts` に新規追加:

```ts
export type DispatchInput = {
  sessionId: string;
  kind: EventKind;             // EventKind に統一 (= NotificationKind 廃止)
  importance?: Importance;     // 省略時は rule.importance
  title: string;
  preview?: string;
  bodyMd?: string;
  payload?: Record<string, unknown>;
  refTable?: string;
  refId?: number;
  speakText?: string;          // toast=true && speak=true で yui_message に使う
  discordText?: string;
  /**
   * 内部で抑制したい場合の flag。news throttle / sleep mode 中等。
   * true なら mode 判定をスキップして toast=false, speak=false で履歴のみ残す。
   */
  suppressed?: boolean;
  /**
   * fire 経路を別に持つ event (= schedule / music) は speak を別経路で
   * 投げるので、ここでは speak を出さず toast だけ出したい。
   * true なら mode の speak フラグを無視して speak=false 扱い。
   */
  skipAutoSpeak?: boolean;
};

export type DispatchResult = {
  notificationId: number | null;
  toastFired: boolean;
  speakFired: boolean;
  discordForwarded: boolean;
};

export async function dispatchNotification(
  input: DispatchInput
): Promise<DispatchResult>;
```

### 4.2 内部フロー

```
1. insertNotificationRow (= 純粋 DB insert のみ、副作用なし、§4.2.1 参照)
   → 失敗時は warn + null 返す、以降スキップ
2. getRule(input.kind)
   → rule.toastFor(state), rule.speakFor(state) を取得 (= 2 軸)
3. await getEffectiveState(sessionId) → rawState ("online"|"away"|"focus"|"private")
4. matrixState 正規化:
   - rawState === "private" → "focus"  (= §8.1、private は modeFocus を参照)
   - それ以外 → rawState そのまま
5. mode 判定:
   - input.suppressed === true → toast=false, speak=false
   - 通常: rule から matrixState ごとの toast / speak boolean を取得
     (= matrixState === "online" → rule.toastOnline / rule.speakOnline、以下同様)
   - input.skipAutoSpeak === true → speak=false に上書き

   **注**: v1 では focus 中 high のみ強制 speak (= 「ラスト砦」) という暗黙 override
   があったが、v2 では matrix の `*_focus` 列を **single source of truth** にする。
   ご主人様がメール(重要)の集中時を ✓/✗ (= toast のみ) に設定したら v2 はその通り、
   ✓/✓ (= toast + speak) を求めるなら matrix で明示する。仕様の予測可能性を優先。
6. toast=true なら pushToSession(notification SSE event)
7. speak=true なら pushToSession(yui_message) + overlay tee
8. Discord 転送 (= rule.discordPolicy、matrixState === "focus" は完全沈黙
   ※ rawState === "private" も focus と同等扱いで沈黙)
```

modeOverride は完全廃止。

### 4.2.1 saveNotification の副作用除去 (= 既存関数の破壊的変更)

**重要**: 現行 `saveNotification` (= `src/lib/notifications.ts:68-177`) は単なる DB insert ではなく、内部で getRule → SSE push → speak fire → Discord 転送まで全部やっている。これを dispatchNotification の step 1 で**そのまま呼ぶと dispatchNotification と既存ロジックが二重 dispatch して、トースト 2 連発・speak 2 連発になる**。

回避策 (= F2 で実装時に必須):

- **案 A (推奨)**: 既存 `saveNotification` を **persistence-only に書き換え**。SSE / speak / Discord ロジックを `dispatchNotification` 側に丸ごと移動。`saveNotification` は名前 `insertNotificationRow` にリネームし、内部関数化 (= export を消し、dispatchNotification からのみ呼ぶ)
- **案 B**: 既存 `saveNotification` を deprecated 扱いで残しつつ、新規 `insertNotificationRow` (= persistence-only) を追加。dispatchNotification は新関数を呼ぶ。**F5 で `saveNotification` 削除**

**推奨は A**。理由は既存呼出 4 箇所 (= news / morning / diary / reminder、§1.1) を全て dispatchNotification に置き換える F2 が完了すれば、`saveNotification` の旧 export を残す意味がなくなる。lib 内部関数として隠蔽するのが綺麗。

F2 セルフチェック:

```bash
# saveNotification の直接呼び出しが lib/notifications.ts 以外に残っていないか
grep -rn "saveNotification(" src --include="*.ts" --include="*.tsx" \
  | grep -v "src/lib/notifications.ts"
# → F2 完了時には出力ゼロを確認
```

### 4.3 news の throttle 統合

`src/periodic/news-fetch.ts` を以下に変更:

```ts
const inThrottle = ... ; // 既存ロジック
await dispatchNotification({
  kind: "news",
  ...,
  speakText: inThrottle ? undefined : await generateNewsSpeech(...),
  skipAutoSpeak: inThrottle,  // throttle 中は rule の speak=true を無視
});
```

これで:
- 通知 UI の rule (= toast / speak フラグ) は引き続き respect される
- throttle 中は **speak だけ抑制**、toast は出る
- ユーザーが「speak しない」を選んでれば throttle 関係なく speak しない

### 4.4 各 dispatcher 経路の修正一覧

| dispatcher | 現状 | v2 修正 |
|---|---|---|
| `morning-check.ts` | saveNotification + getRule あり (重複 fire) | dispatchNotification に置換、別経路の prompt fire は維持 (= 朝の rich 挨拶は別) |
| `news-fetch.ts` | saveNotification + 自前 throttle | dispatchNotification + skipAutoSpeak (= §4.3) |
| `diary-write.ts` | saveNotification、getRule なし | dispatchNotification に置換、設定経由 |
| `reminder-dispatch.ts` | 3-way 分岐で saveNotification or speak fire | dispatchNotification に統合 |
| `music-commands.ts` | 独自 fire 経路、saveNotification 通らない | **toast は dispatchNotification 経由 (= 履歴に残す + 通知センター表示)、speak は既存の `notifyYuiSongChanged` の内部 /api/chat fire を維持** (= 曲ごとに trivia 含む動的 speakText が必要、dispatchNotification の静的 speakText では表現力不足)。dispatchNotification 側は `skipAutoSpeak: true` で speak 抑制、`notifyYuiSongChanged` 側は引き続き `rule.speakFor(state)` を見て speak=false なら fire しない |
| `calendar-check.ts` | 直接 fire (= `fire: { prompt }` で scheduler が内部 `/api/chat` 起動)、saveNotification なし、終日 filter なし | **music と同じ分離パターン**: toast / 履歴は dispatchNotification 経由 (= 設定参照 + 履歴 + 通知センター表示)、speak は既存の `fire: { prompt }` 経路を維持 (= 「3 分後に予定『○○』が始まります」のような動的予告文を Yui に作らせるため、静的 speakText では表現力不足)。dispatchNotification 側は `skipAutoSpeak: true`。設定参照: calendar-check.ts 側で `rule.speakFor(state)` を見て speak=false なら `fire: undefined` を返す。終日 filter は §5 参照、kind="schedule" |
| `mail-poll.ts` | saveNotification 呼出なし | dispatchNotification 経由で important / other 振り分け |
| `timers.ts` | 独自 UI、設定 BYPASS | 触らない (= §2.8) |
| health (= 未実装) | — | Phase G+ で別途 |

---

## 5. 終日 event の扱い (= schedule の終日除外)

`src/periodic/calendar-check.ts` の修正:

```ts
function eventStartMs(e: CalEvent): number {
  if (e.start.dateTime) return new Date(e.start.dateTime).getTime();
  // 終日 event (e.start.date のみ) は通知しない → NaN を返して filter で除外
  return NaN;
}
```

これで `Number.isFinite(startMs)` の既存 filter (行 62) で終日が落ちる。終日 event の通知ニーズが将来出たら、`schedule_allday` という別 kind + 朝の briefing への組み込みで対応する (= 0 時前に「3 分後」と言うのは仕様として誤り、固有 module で扱うべき)。

---

## 6. 重要送信者判定 (= mail_important)

`mail_curation_settings` には既存で「重要送信者」list がある (= Mail Classification Phase 1-4 で実装済)。

`mail-poll.ts` で各 mail row について:

```ts
const importance = isImportantSender(mail.from) ? "high" : "normal";
const kind: EventKind = isImportantSender(mail.from) ? "mail_important" : "mail_other";
await dispatchNotification({
  kind,
  importance,
  sessionId,
  title: kind === "mail_important" ? `重要メール: ${mail.subject}` : mail.subject,
  preview: `${mail.fromName} さんから`,  // body 含めない (= §16 プライバシー)
  bodyMd: undefined,  // 通知本文には mail body を入れない、replay で別途取得
  refTable: "mails",
  refId: mail.id,
  speakText: kind === "mail_important"
    ? `${mail.fromName} さんから重要メールが届いてますよ。件名は「${mail.subject}」です。`
    : `${mail.fromName} さんからメールが届きました。`,
  discordText: undefined,  // mail は離席時に Discord に転送 (= rule.discordPolicy)
});
```

判定関数 `isImportantSender` は既存の `src/lib/mail-classify.ts` 等に流用できるはず (実装時確認)。

---

## 7. importance / 効果音

v1 から変更なし。

```
high   → 2 音ピンポン or 短いハープグリッサンド (0.8s)
normal → 1 音の柔らかいベル (チーン)            (0.5s)
low    → 控えめな小鈴 (ぽぉん)                  (0.4s)
silent → 鳴らない (toast のみ表示)
```

ただし v2 では:
- **toast=false の通知は効果音も鳴らない** (= 鳴る場所が消えるので物理的に)
- **speak=true && toast=false** (= 読み上げのみ) は効果音なし、Yui の声だけ流れる

---

## 8. ユーザー状態 (= 既存) + quiet hours (= 新規 UI 化)

### 8.1 ユーザー状態 (v1 から変更なし)

- `online / away / focus / private` の 4 状態
- **60 秒 stale** で away 自動降格 (= focus / private は対象外、`src/lib/activity.ts:90` 参照)
- 集中モードは手動切替のみ、自動解除なし
- private モードは focus と同じく振り分けロジック上 modeFocus を参照

### 8.2 サイレント時間帯 (= quiet hours、v2 新規)

v1 の「夜間 22-7 JST」ハードコードを廃止し、UI 設定に置換。

**スキーマ**: `src/db/migrations/0065_quiet_hours_settings.sql` (新規)

```sql
CREATE TABLE IF NOT EXISTS quiet_hours_settings (
  id          SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  enabled     BOOLEAN      NOT NULL DEFAULT FALSE,
  start_hour  SMALLINT     NOT NULL DEFAULT 22 CHECK (start_hour BETWEEN 0 AND 23),
  end_hour    SMALLINT     NOT NULL DEFAULT 7  CHECK (end_hour   BETWEEN 0 AND 23),
  updated_at  TIMESTAMPTZ  NOT NULL DEFAULT now()
);
INSERT INTO quiet_hours_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
```

**lib**: `src/lib/quiet-hours.ts` (新規)

```ts
export type QuietHours = {
  enabled: boolean;
  startHour: number;  // 0-23
  endHour: number;    // 0-23
};

export async function getQuietHours(): Promise<QuietHours>;
export async function setQuietHours(patch: Partial<QuietHours>): Promise<QuietHours>;
export async function isInQuietHours(now?: Date): Promise<boolean>;
```

判定ロジック:

```ts
function inRange(hour: number, start: number, end: number): boolean {
  if (start === end) return false;                              // サイレント無し扱い
  if (start < end) return hour >= start && hour < end;          // 通常: [start, end)
  return hour >= start || hour < end;                           // 跨ぎ: [start, 24) ∪ [0, end)
}
```

`hour` は `Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", hour: "2-digit", hour12: false })` で算出 (= サーバ TZ 非依存)。

**Valkey cache**: `quiet-hours:singleton`、TTL 30 秒。

### 8.3 `activity.ts` の修正

before (現状):

```ts
export function getEffectiveState(sessionId: string): UserState {
  // ...
  if (isNightJST() && state !== "focus" && state !== "private") {
    state = "away";
  }
  return state;
}
```

after:

```ts
export async function getEffectiveState(sessionId: string): Promise<UserState> {
  // ...
  const { isInQuietHours } = await import("@/lib/quiet-hours");
  if ((await isInQuietHours()) && state !== "focus" && state !== "private") {
    state = "away";
  }
  return state;
}
```

`isNightJST()` 関数は削除。

**呼出元 await 化**: 既存の `getEffectiveState` 呼出 **7 箇所** を全て `await` に変更 (= `rg "getEffectiveState\(" src` で確認済):

| ファイル | 行 (現状) | 用途 / 注意点 |
|---|---|---|
| `src/lib/music-commands.ts` | 237 | song-change の mode 判定 |
| `src/lib/notifications.ts` | 94 | saveNotification → dispatchNotification 内の mode 判定 |
| `src/periodic/morning-check.ts` | 185 | 朝ブリーフ振り分け |
| `src/periodic/reminder-dispatch.ts` | 28 | リマインダー振り分け |
| `src/app/api/chat/route.ts` | **531** | **`!== "private"` 比較。`await` 忘れると常に true (= Promise !== string) になり private mode 漏洩。最優先で要修正** |
| `src/app/api/chat/route.ts` | **1126** | `effectiveUserState` 取得、後段で比較。同じく `await` 必須 |
| `src/app/api/activity/route.ts` | 78 | GET endpoint で current state を返す |

呼出元はすべて async 関数の内部なので await 追加だけで済む (= UI には降ろさない)。**`chat/route.ts:531` だけは厳重注意** — await 漏らすと private 判定が常に通って、会話履歴が DB に書かれる挙動になる (= private mode の前提が崩れる)。

実装時セルフチェック:

```bash
# 修正漏れ検出
grep -rn "getEffectiveState(" src --include="*.ts" --include="*.tsx" | grep -v "^.*await\|= async"
# → 出力ゼロを確認
```

---

## 9. 集中モード (= v2 で挙動明示化)

- 手動切替のみ、自動解除なし
- 集中中の通知振り分け: **matrix の `toast_focus` / `speak_focus` 列が single source of truth** (= v1 の暗黙 override は廃止、§4.2 注記参照)
  - DEFAULT_RULES では大半が `toast_focus=true, speak_focus=false` (= 履歴とトーストは残すが speak しない)
  - 予定 (= schedule) のみデフォルトで `speak_focus=true` (= 集中中でも仕事の予定は逃さない、§3 表参照)
  - ユーザーが individual rule を変更すれば集中中の挙動も自由に上書き可
- Discord 配信は集中中 **完全沈黙** (= rule.discordPolicy 関係なく抑制)
- 解除時に「集中中のお便りが ○件 ありました」と一言

設計判断: v1 の「ラスト砦」(= focus 中 high のみ強制 speak) は user に予測しにくい挙動だった。v2 では matrix を厳密に反映、important 通知を集中中に speak したいなら設定で明示する責任を user に渡す。

---

## 10. データモデル (= v2 変更)

### 10.1 notifications テーブル (= 変更なし)

```sql
CREATE TABLE notifications (
  id BIGSERIAL PRIMARY KEY,
  session_id TEXT NOT NULL,
  kind TEXT NOT NULL,              -- EventKind に統一
  importance TEXT NOT NULL,
  title TEXT NOT NULL,
  preview TEXT,
  body_md TEXT,
  payload JSONB,
  ref_table TEXT,
  ref_id BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  seen_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ
);
```

schema 変更なし。`kind` の意味だけ統一 (= NotificationKind 廃止)。

### 10.2 notification_settings テーブル (= 変更)

**v1**:
```sql
CREATE TABLE notification_settings (
  event_kind     TEXT PRIMARY KEY,
  mode_online    TEXT NOT NULL,  -- "speak" / "notify" / "silent"
  mode_away      TEXT NOT NULL,
  mode_focus     TEXT NOT NULL,
  discord_policy TEXT NOT NULL,
  importance     TEXT NOT NULL,
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

**v2** (= migration 0066、idempotent):
```sql
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS toast_online BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS speak_online BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS toast_away   BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS speak_away   BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS toast_focus  BOOLEAN;
ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS speak_focus  BOOLEAN;

-- 既存 mode_* 列から変換 (= NULL の行だけ埋める、再適用安全)
UPDATE notification_settings SET
  toast_online = (mode_online IN ('speak', 'notify')),
  speak_online = (mode_online = 'speak'),
  toast_away   = (mode_away   IN ('speak', 'notify')),
  speak_away   = (mode_away   = 'speak'),
  toast_focus  = (mode_focus  IN ('speak', 'notify')),
  speak_focus  = (mode_focus  = 'speak')
WHERE toast_online IS NULL;  -- ← 二回目以降は対象 0 行

-- 全行が値を持つことを確認してから NOT NULL 化
ALTER TABLE notification_settings ALTER COLUMN toast_online SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN speak_online SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN toast_away   SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN speak_away   SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN toast_focus  SET NOT NULL;
ALTER TABLE notification_settings ALTER COLUMN speak_focus  SET NOT NULL;

-- mode_* は当面残す (= ロールバック保険、Phase F5 で drop)
```

### 10.3 schedule eventKind 追加

`DEFAULT_RULES` に行追加:

```ts
{
  eventKind: "schedule",
  toastOnline: true, speakOnline: true,
  toastAway:   true, speakAway:   true,
  toastFocus:  true, speakFocus:  true,  // 予定は集中中でも speak (= 仕事を逃さない)
  discordPolicy: "away_only",
  importance: "high",
},
```

### 10.4 EventKind 列挙更新

```ts
// 旧 (v1):
export type EventKind = "timer" | "morning_brief" | "diary" | "news"
  | "mail_important" | "mail_other" | "music" | "health" | "reminder";

// 新 (v2):
export type EventKind = "morning_brief" | "diary" | "news"
  | "mail_important" | "mail_other" | "music" | "schedule" | "health" | "reminder";
//   ↑ timer 削除                                                    ↑ schedule 追加
```

`timer` は §2.8 の通り独自 UI なので EventKind から外す。DEFAULT_RULES からも削除。

**将来拡張: `mail_threat`** — フィッシング / 詐欺 / なりすまし検出時の通知。詳細は [`docs/mail-threat-detection.md`](mail-threat-detection.md) §13.1 (= G1 差分一覧) で定義され、Phase G1 実装時に本書 EventKind / DEFAULT_RULES / KIND_LABEL / VALID_KIND が拡張される。

### 10.5 quiet_hours_settings テーブル (= migration 0065、§8.2)

§8.2 参照。

### 10.6 NotificationKind 型廃止

`src/lib/notifications.ts:17-25` の `NotificationKind` 型を削除し、全 import 元を `EventKind` に置換。

---

## 11. quiet hours UI

### 11.1 配置

`src/components/NotificationsSection.tsx` の既存テーブルの **上** に新セクションを差し込む。SettingsModal の「通知」タブ内。

### 11.2 レイアウト (ASCII モック)

```
┌─ 通知 ────────────────────────────────────────────────────┐
│ 通知の種類ごとに、状態(オンライン/離席/集中)での挙動と       │
│ Discord 配信、優先度を設定できます。                         │
│                                              [既定値に戻す] │
│                                                             │
│ ╭─ サイレント時間帯 ──────────────────────────────────────╮ │
│ │ ☐ 指定した時間帯は自動的に "離席" 扱いにする             │ │
│ │                                                         │ │
│ │ 開始 [22 ▼] 時 〜 終了 [ 7 ▼] 時                        │ │
│ │                                                         │ │
│ │ ヒント: 跨ぎ指定可 (= 例: 23→6 で 23 時〜翌 6 時)。     │ │
│ │ 集中 / プライベートモード中は対象外。                   │ │
│ ╰─────────────────────────────────────────────────────────╯ │
│                                                             │
│ ┌─────────────────────────────────────────────────────────┐ │
│ │ 発火元           オンライン      離席       集中         │ │
│ │                  ┌──┐ ┌──┐    ┌──┐ ┌──┐  ┌──┐ ┌──┐    │ │
│ │                  │T │ │S │    │T │ │S │  │T │ │S │     │ │
│ │ 朝のブリーフ     │✓│ │✗│    │✓│ │✗│  │✓│ │✗│      │ │
│ │ ニュース新着     │✓│ │✓│    │✓│ │✗│  │✓│ │✗│      │ │
│ │ 予定             │✓│ │✓│    │✓│ │✓│  │✓│ │✓│      │ │
│ │ メール (重要)    │✓│ │✓│    │✓│ │✗│  │✓│ │✗│      │ │
│ │ ...                                                     │ │
│ └─────────────────────────────────────────────────────────┘ │
│       T = toast (お便り) / S = speak (読み上げ)             │
└─────────────────────────────────────────────────────────────┘
```

### 11.3 UI 仕様詳細

- **トグル**: チェックボックス、`<label>` で関連付け、デフォルト OFF
- **時刻セレクト**: `<select>` × 2、option は 0-23 の整数
- **トグル OFF 時**: 時刻セレクトを disabled
- **マトリックステーブル**: 各 state 列を 2 サブ列 (toast / speak) に分割、それぞれ checkbox or icon button
- **autosave**: 既存パターン (= 楽観更新 + 失敗時 rollback) を踏襲
- **Discord 列 + 優先度列**: v1 と変更なし

### 11.4 timer 行の削除

§2.8 の通り、設定 UI から timer 行を外す。マトリックス上には出ない。

---

## 12. API

### 12.1 既存 (= v1 から変更なし)

```
GET    /api/notifications?unread_only=1&limit=20
PATCH  /api/notifications/<id>/seen
POST   /api/notifications/<id>/replay
POST   /api/notifications/<id>/dismiss
POST   /api/notifications/seen_all
POST   /api/notifications/replay_all
POST   /api/activity
GET    /api/notification-settings
PATCH  /api/notification-settings/<event_kind>
POST   /api/notification-settings/reset
```

### 12.2 v2 新規

```
GET    /api/quiet-hours          { enabled, startHour, endHour }
PATCH  /api/quiet-hours          (= 部分更新可)
```

PATCH バリデーション:
- `enabled`: boolean のみ
- `startHour` / `endHour`: 0-23 整数のみ、範囲外は 400

エラーハンドリング: `CLAUDE.md` 規約通り `clientError()` 使用、context `"quiet-hours"`、固定文「サイレント時間帯の更新に失敗しました」。

### 12.3 v2 修正

`PATCH /api/notification-settings/<event_kind>` の request body schema 拡張 (= **後方互換あり**):

```ts
// 旧 (v1) - F4 完了までこちらも受け付ける
{ modeOnline?, modeAway?, modeFocus?, discordPolicy?, importance? }

// 新 (v2):
{
  toastOnline?, speakOnline?,
  toastAway?,   speakAway?,
  toastFocus?,  speakFocus?,
  discordPolicy?, importance?
}
```

**重要 (= 移行順序の安全策)**:

F2 で API + schema を先に変更するが、UI 改修は F4。**F2 〜 F4 の間は旧 UI が引き続き `modeOnline` 等を送る**ため、新 API は旧 field を受けたら以下の変換を内部で行う:

```ts
// 互換変換 helper (Phase F5 まで残す)
function legacyModeToFlags(m: "speak" | "notify" | "silent"): { toast: boolean; speak: boolean } {
  return {
    toast: m === "speak" || m === "notify",
    speak: m === "speak",
  };
}

// PATCH handler 冒頭で:
if (body.modeOnline)  Object.assign(body, prefix("Online",  legacyModeToFlags(body.modeOnline)));
if (body.modeAway)    Object.assign(body, prefix("Away",    legacyModeToFlags(body.modeAway)));
if (body.modeFocus)   Object.assign(body, prefix("Focus",   legacyModeToFlags(body.modeFocus)));
// prefix("Online", {toast, speak}) → { toastOnline: ..., speakOnline: ... }
```

これで F2-F4 の間も「旧 UI から `modeOnline: "speak"` を送る → 内部で `{ toastOnline: true, speakOnline: true }` に変換して DB 更新」が成功する。「無視」ではなく「変換」する。

**Phase F5 で旧 field を完全 reject** に切り替え (= 旧 UI の残骸が他に紛れていないか確認後)。

---

## 13. SSE Event 拡張

v1 から変更なし。`NotificationEvent` は引き続き既存形:

```ts
export type NotificationEvent = {
  type: "notification";
  id: number;
  kind: string;     // EventKind に統一
  importance: "high" | "normal" | "low" | "silent";
  title: string;
  preview: string;
  speakText?: string;       // Discord 転送用 (Web では使わない、yui_message を別途 push)
  forwardToDiscord: boolean;
};
```

speak fire は引き続き `yui_message` event で。

---

## 14. UI 配置 (= v1 から実質変更なし、設定 modal だけ §11)

- トースト位置 (画面左下スタック) — 変更なし
- ReportPanel での replay 表示 — 変更なし
- LogModal「お便り履歴」タブ — 変更なし
- SettingsModal「通知」タブ — §11 に従って **トグル + マトリックス列再構成**

種別アイコン (line SVG):
- `morning_brief`: 朝日
- `news`: 新聞
- `diary`: 開いたノート
- `mail_important` / `mail_other`: 封筒 (= 重要は ★ マーク重ね)
- `music`: 音符
- `schedule`: カレンダー
- `reminder`: ベル
- `health`: 心拍ライン

---

## 15. 実装フェーズ

| Phase | 内容 | 工数目安 |
|---|---|---|
| **F1** | migration 0065 (quiet_hours) + 0066 (notification_settings 列追加) + schema.ts + 既存 DB 値変換 + `getEffectiveState` async 化 + **呼出元 await 化 (7 箇所、§8.3 表参照)** + lib/quiet-hours.ts | 半日 |
| **F2** | `dispatchNotification` 関数実装 + **既存 `saveNotification` を persistence-only `insertNotificationRow` にリネーム + 内部関数化** (= §4.2.1 推奨案 A、SSE/speak/Discord ロジックを dispatchNotification 側に移動) + 既存 saveNotification 経由 4 箇所 (news / morning / diary / reminder) を dispatchNotification 経由に書き換え + EventKind 統合 (NotificationKind 廃止) + **PATCH /api/notification-settings に旧 field `modeOnline/modeAway/modeFocus` 受信時の compat 変換を実装** (= §12.3 参照、F4 で UI が新 field 送信に切り替わるまで必須、F5 で削除) | 半日〜1 日 |
| **F3** | calendar-check (= schedule) 改修 (= 終日 filter + dispatchNotification 経由) + mail-poll (= dispatchNotification 配線) + music-commands を dispatchNotification 経由に統合 | 半日〜1 日 |
| **F4** | UI 改修: SettingsModal 通知タブにサイレント時間帯セクション追加 + マトリックス列再構成 (toast / speak 独立) + timer 行削除 + autosave 動作確認 | 半日 |
| **F5** | 動作確認 + 旧 mode_* 列 drop (= migration 0067) + 旧 modeOverride 引数の削除 (= 後方互換コード除去) | 半日 |
| **(G+)** | health 通知の発火元設計 + 実装 | 別途 |

各 Phase 単独で動作確認可。F1 → F2 → F3 → F4 → F5 の順で。

---

## 16. プライバシー / セキュリティ

- v1 から変更なし
- mail 実装 (§6) で **subject のみ preview に入れ、body は入れない** ことを再確認
- `dispatchNotification` の payload に PII を入れないこと (= refTable / refId で indirection)
- quiet hours 設定は user-level、外部送信なし

---

## 17. 後方互換性と移行戦略

### 17.1 schema migration

- 0065 (quiet_hours_settings): 新規 table、既存影響なし
- 0066 (notification_settings 列追加): 旧 `mode_*` 列を残しつつ新 `toast_*` / `speak_*` を追加、データ自動変換
- 0067 (Phase F5、旧列 drop): F1-F4 で安定動作確認後に実施

### 17.2 ロールバック

各 Phase 終了後に問題が出た場合の戻し方:

- **F1 完了後** (= migration 0065/0066 + `getEffectiveState` async 化): `getEffectiveState` を sync に戻す + 呼出 7 箇所の await を外す + `isInQuietHours` 参照を削除 (= `isNightJST` の旧実装に戻す)。schema 上の新列 (`toast_*` / `speak_*`) は NULL 許容ではなく既に NOT NULL 化 + データ変換済みなので、放置でも v1 ロジックは旧 `mode_*` 列のみ参照するため動作影響なし
- **F2 完了後** (= `dispatchNotification` 実装 + saveNotification の `insertNotificationRow` リネーム + 4 dispatcher 書き換え + PATCH API compat 変換): dispatchNotification 呼出 4 箇所を旧 saveNotification 呼出形に巻き戻す + `insertNotificationRow` を `saveNotification` にリネームし直し、内部に SSE/speak/Discord ロジックを書き戻す。PATCH API は compat 変換が旧 API と互換なので残置可
- **F3 完了後** (= schedule / mail / music を dispatchNotification 経由化、終日 filter 追加): 各 dispatcher 経路を F2 完了時点に戻す (= calendar-check は `fire: { prompt }` のみ、mail-poll は通知無し、music は専用 fire のみ)。終日 filter は単独で安全なので残置可
- **F4 完了後** (= UI 改修): NotificationsSection.tsx を v1 (= 3 値 mode select) に戻す。API は compat 変換で旧 field を受けるので動く
- **F5 完了後** (= 旧列 drop migration 0067): 旧列を復元する down migration を別途用意する必要あり。F1-F4 中はこの段階に到達させない

### 17.3 user への影響

- **既存マトリックス設定は自動変換** (= `speak → toast+speak`, `notify → toast only`, `silent → silent`)
- **「読み上げのみ」(= toast=false, speak=true) は v2 から新規** なので、user が選ばない限り発生しない
- **22-7 夜間オーバーライド消滅**: quiet hours トグルがデフォルト OFF なので、**v1 で「夜は自動的に静かだった」体感が無くなる**。リリースノートで案内必須:
  > 「以前は 22-7 が自動で静かでしたが、v2 では設定 → 通知 → サイレント時間帯を ON にして同等の動作になります」
- **mail 通知が新しく届くようになる** (= 今まで来てなかったので user 体感は「新機能」)。デフォルトでメール (重要) は speak、メール (それ以外) は toast のみで届く
- **schedule (= 予定 5 分前) が設定で制御可能に** (= 今まで強制発火だったので、消したい人は silent に変えられる)
- **終日予定の 0 時前通知が消える**

---

## 18. 将来の拡張余地

- **per-eventKind なサイレント時間** (= music だけ夜静かに、health は夜でも speak、等) — `notification_settings` に `quiet_action TEXT` 列 (= 'force_silent' | 'force_toast_only' | 'respect_state') を追加するだけで実装可。需要が見えてから
- **複数のサイレント時間帯** (= 0-6 と 13-14 を両方) — `quiet_hours_settings` を per-row 化、`enabled` rows の OR で判定
- **曜日別** — `weekday_mask SMALLINT` (= 7bit) を追加
- **カレンダー連動** (= Google Calendar の "BUSY" 中は強制 quiet) — schedule kind の dispatcher 内で `gcal.busyNow()` チェック
- **学習** — 「3 回 dismiss されたら importance を 1 段下げる提案を Yui からする」
- **mode 表現の更なる拡張** — toast/speak の 2 軸では足りないシーンが出たら、`discord_mode` も per-state に分離する案
- **health 通知の発火源** — 体重 / 食事 / 運動の閾値超え検知 + speak fire
- **読み上げモード = 暗黙の集中モード** (= 長文 TTS 中は通知抑制) — v1 §12 で書かれた案、F+ で別途

---

## 19. 監査スクリプト (= 開発時セルフチェック)

新規 dispatcher を追加するたびに以下を grep して、設定 BYPASS していないか確認:

```bash
# saveNotification 直叩きを禁止 (= dispatchNotification を通すべき)
grep -rn "saveNotification(" src/lib src/periodic src/app --include="*.ts" \
  | grep -v "src/lib/notifications.ts"
# → ヒット = 統一インターフェイス bypass している。要見直し

# getRule を呼ばずに mode 判定している経路を検出
grep -rn "rule.modeOnline\|rule.modeAway\|rule.modeFocus" src --include="*.ts"
# → v2 では rule.toastOnline / rule.speakOnline / ... のみ使うべき
```

---

## 20. ライセンス / コミット規約 (= 参考)

`CLAUDE.md` 規約に従う:
- API route catch ブロックは `clientError()` を使う
- 新規 migration は `IF NOT EXISTS` で idempotent に
- 新規 dependency 無し
- Commit 単位は Phase 区切りで、message に「Phase F1: ...」のように Phase 番号を入れる
