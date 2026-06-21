# Tool Agent State v6 — 設計書

> ステータス: 設計ドラフト
> 作成日: 2026-06-21
> 関連:
> - [chat-tool-gating-v5.md](./chat-tool-gating-v5.md)
> - [tool-dispatch-redesign.md](./tool-dispatch-redesign.md)
> - [tool-architecture.md](./tool-architecture.md)
> - [tool-dedup-and-adding-tools.md](./tool-dedup-and-adding-tools.md)

## 0. 目的

v0.2 以降の Tool Gate / Executor / ToolDef / specialist / confirm / dedup の追加で、個別の安全網は増えた。
一方で、状態の受け渡しが自然文や各所の if 文に分散し、以下の事故が起きている。

- ツール結果前の main 発話が事実誤答する
- confirmation 待ちを完了扱いして二重報告する
- specialist voice と confirm 完了報告が同じ実行を別々に報告する
- silent direct tool が定型文だけで返る
- dedup / confirm / Executor / report の責務境界が読みづらい

v6 の目的は、**あらゆるタスクを「正確に実行し、正確に応答する」ため、ツール実行を状態機械として扱うこと**。
LLM に自然文から状態を推測させず、サーバ側が構造化 state を持つ。

## 1. 現状整理

### 1.1 現在の流れ

現在の通常 chat は概ね次の構造。

```
POST /api/chat
  -> messages/env/memory/persona 構築
  -> Tool Gate
      no_tool       -> main LLM 応答
      tool_required -> Executor
            direct tool     -> dispatchTool -> runTool -> handler
            specialist tool -> dispatchSpecialistJob -> runSpecialist -> voice/report
  -> 必要なら main C 応答
  -> raw_messages 保存 / SSE
```

ただし confirm 系では追加の内部 turn がある。

```
runTool(confirm tool)
  -> confirm_required tool_result
  -> UI confirmation
  -> POST /api/tool-confirm/:token
  -> executePendingTool
  -> internal POST /api/chat source=tool_confirm_result
  -> confirm 完了報告
```

### 1.2 問題の根

現状は、各層が「次に何を喋るべきか」を自然文から推測している。

- `runSpecialist()` は `text` しか返さない
- `dispatcher.ts` は `specResult.text` の文面で `確認待ち` を判定しようとしている
- `chat/route.ts` は `pendingJobs.length` / `toolCallCount` / `finalIterText` で応答を組み立てている
- `confirm_required` は tool_result JSON にはあるが、specialist job 全体の状態として保持されていない
- direct tool の silent 成功は「何をしたか」の応答生成層がなく、最後に `かしこまりました。` へ落ちる

つまり、状態は存在するが、**局所的 JSON / DB reservation / raw message / 自然文に分散**している。

## 2. 設計原則

1. **自然文を状態判定に使わない。**
   `確認待ち`, `登録しました` などの文字列 grep で制御しない。

2. **ツール実行結果は必ず構造化 envelope に入れる。**
   tool_result JSON、specialist text、confirm token、dedup skip を共通型に正規化する。

3. **発話生成は状態機械の最終段にだけ置く。**
   実行中・確認待ち・完了・失敗・重複スキップのどれかを確定してから LLM に喋らせる。

4. **confirmation 待ちは完了ではない。**
   `pending_confirmation` では user-visible 完了報告を出さない。最終報告は confirm 後に 1 回だけ。

5. **specialist と direct tool の結果表現を揃える。**
   specialist も「人間向け text」だけでなく、`status` と `actions` を返す。

6. **main LLM は通常会話と最終報告に限定する。**
   tool selection / tool state / confirm state は main LLM に任せない。

7. **route.ts はオーケストレータに戻す。**
   状態集約・応答判断・保存・SSE を小さなモジュールに分離する。

## 3. 中核モデル

### 3.1 Turn State

ユーザー入力 1 回を `TurnState` として扱う。

```ts
type TurnState =
  | "received"
  | "classified_no_tool"
  | "classified_tool_required"
  | "executing_tools"
  | "waiting_confirmation"
  | "waiting_specialist"
  | "completed"
  | "failed";
```

### 3.2 Tool Run State

tool call 1 件を `ToolRunState` として扱う。

```ts
type ToolRunState =
  | "not_started"
  | "executing"
  | "pending_confirmation"
  | "executed"
  | "skipped"
  | "failed"
  | "cancelled";
```

### 3.3 Unified Tool Outcome

direct tool / specialist / confirm 後の結果を共通 envelope に正規化する。

```ts
type UnifiedToolOutcome = {
  id: string;
  turnId?: string;
  jobId?: number;
  toolUseId?: string;
  confirmToken?: string;
  reservationId?: string;
  source: "chat_turn" | "specialist_job" | "tool_confirm" | "dedup";
  toolName: string;
  kind: "direct" | "specialist" | "confirm_result";
  state: ToolRunState;
  disposition: "silent" | "report";
  responsePolicy: "none" | "ack" | "final" | "report" | "confirmation";
  userVisible: "none" | "ack" | "final" | "error" | "confirmation";
  input: unknown;
  result: unknown;
  error?: string;
  skipReason?: "dedup_recent_execution" | "budget" | "depth" | "duplicate";
  confirmation?: {
    token: string;
    summary: string;
    policy: "confirm_destructive" | "confirm_external_send";
  };
  reportHints?: {
    title?: string;
    summary?: string;
    occurredAt?: string;
  };
};
```

重要なのは `source` / `responsePolicy` / `userVisible`。

`source` と相関 ID は、同じ実行を chat turn / specialist job / confirm result の間で追跡するために必須。
特に mutation tool は `toolUseId`、confirm tool は `confirmToken`、dedup 対象は `reservationId` を持つ。

`responsePolicy` は tool 定義または aggregator が決める「この outcome をどう扱うべきか」。
`disposition=silent` でもユーザーに完了報告が必要な tool は `final` になり、逆に副作用のない内部 tool は `none` のままにできる。

- `none`: ここでは発話しない
- `ack`: 受付だけ返す
- `confirmation`: confirm UI event が発行済みであることを示す。完了発話は禁止
- `final`: 完了報告を 1 回出す
- `error`: 失敗報告を出す

この値をもとに発話生成を決める。

### 3.4 State Persistence

state はメモリ上の一時値だけにしない。
HTTP request をまたぐ confirm / specialist job / SSE 復元に耐えるため、次の境界で保存する。

| state | 保存先 | 理由 |
|---|---|---|
| chat turn の分類・plan | 現行 schema では `raw_messages.toolSummary` / `tasks.output` / debug log。将来 `raw_messages.metadata` 追加も可 | 後から「なぜその応答になったか」を追跡する |
| specialist job state | `tasks.status` + `tasks.output.state/outcomes` | background job の途中状態と最終結果を復元する |
| confirm pending | Valkey pending + `tool_execution_log` reservation | TTL 付き UI 確認と dedup 予約を紐づける |
| confirm final | `raw_messages` + `tool_execution_log` final status | 完了報告を 1 回だけ保存し、重複実行を抑止する |
| dedup skip | `UnifiedToolOutcome` + debug log | handler 未実行であることを明示する |

`tasks.status` は DB schema の制約に合わせて段階移行する。
ただし論理状態として `pending_confirmation` を `tasks.output.state` に必ず残す。
将来的に enum を拡張できるなら `waiting_confirmation` を status として追加する。

### 3.5 Outcome State Reduction

1 回の turn / specialist job で複数 outcome が出るため、集約 state は明示的に縮約する。
自然文 text から判定しない。

優先順位:

1. `pending_confirmation`: 1 件でも確認待ちがあれば、完了報告は禁止
2. `failed`: 全件失敗、または主要 mutation が失敗した場合
3. `partial`: 成功と失敗、成功と budget/depth skip が混在する場合
4. `skipped`: 全件 dedup/budget/depth で skip された場合
5. `completed`: 発話対象の outcome がすべて `executed` または期待された `skipped`

複数 confirmation が同時に出そうな場合は、現行の session 単位 1 pending 制約を維持する。
2 件目以降は `skipped` または `failed` として、追加確認が必要であることを outcome に残す。

## 4. 新アーキテクチャ

### 4.1 全体像

```
Chat Route
  -> ChatTurnController
       -> ContextBuilder
       -> ToolGate
       -> ExecutorRunner
       -> ToolStateAggregator
       -> ResponsePlanner
       -> ResponseRenderer
       -> Persistence/SSE
```

責務:

| コンポーネント | 責務 |
|---|---|
| `ContextBuilder` | persona / env / memory / trusted history / runtime facts の構築 |
| `ToolGate` | `no_tool` / `tool_required` の分類だけ |
| `ExecutorRunner` | clean prompt で tool calls を出し、direct/specialist に振り分ける |
| `ToolStateAggregator` | direct / specialist / confirm / dedup 結果を `UnifiedToolOutcome[]` に正規化 |
| `ResponsePlanner` | state から「今ユーザーに何を出すか」を決める |
| `ResponseRenderer` | persona 付き LLM または固定 fallback で発話を作る |
| `Persistence` | raw_messages / overlay / tool_execution_log / task output の保存 |

`route.ts` はこの流れを呼ぶだけにする。

### 4.2 ResponsePlanner

応答判断はここに一本化する。

```ts
type ResponsePlan =
  | { kind: "main_chat"; prompt: MainPrompt }
  | { kind: "tool_ack"; ackType: "schedule" | "mail" | "research" | "generic" }
  | { kind: "tool_final"; outcomes: UnifiedToolOutcome[] }
  | { kind: "confirmation_pending"; outcomes: UnifiedToolOutcome[] }
  | { kind: "tool_error"; outcomes: UnifiedToolOutcome[] }
  | { kind: "none" };
```

基本ルール:

| 状態 | 応答 |
|---|---|
| `no_tool` | `main_chat` |
| specialist job queued | `tool_ack` |
| direct success + `responsePolicy=final` | `tool_final` を LLM で 1 文生成 |
| direct success + `responsePolicy=report` | `tool_final` または report panel 更新 |
| direct success + `responsePolicy=none` | `none` |
| `pending_confirmation` | **原則 `none`**。UI confirm が出る。必要なら「確認してください」の1文だけ |
| confirm executed | `tool_final` を LLM で 1 回生成 |
| dedup skip | `tool_final` で「既にあるので追加しませんでした」 |
| failed | `tool_error` |

特に `pending_confirmation` は、specialist voice を出さない。
これで「確認待ちの段階で登録しました」と「confirm 後に登録しました」の二重報告を消す。

注意: `ResponsePlanner` は confirm UI event を新規発行しない。
confirm UI event は `requestUserConfirm()` が `tool_confirm_request` SSE として発行済みである。
`ResponsePlanner` の責務は、該当 outcome で完了報告・report・raw assistant message を出さないこと。

## 5. direct tool / specialist / confirm の整理

### 5.1 direct tool

現状:

- `dispatchTool` は `executionState` を持っている
- `aggregateForReport` は一部だけ集約する
- silent success は空 reply になり、最後に `かしこまりました。` へ落ちる

v6:

- `dispatchTool` の戻り値を `UnifiedToolOutcome` に変換する
- silent success でも `responsePolicy=final` なら `tool_final` を作る
- `responsePolicy=none` の内部 tool は、成功しても会話には出さない
- 発話は `ResponseRenderer.renderToolFinal()` が persona prompt + outcome JSON だけで作る
- fallback は固定文だが通常は LLM に生成させる

`responsePolicy` の初期値:

| tool 種別 | responsePolicy |
|---|---|
| 予定・リマインダー・todo などの mutation 成功 | `final` |
| read-only tool の factual report | `report` または `final` |
| specialist 内部の補助 read | `none` |
| confirm 必須 mutation の pending | `confirmation` |
| dedup skip | `final` |

### 5.2 specialist

現状:

- `runSpecialist()` は `text` と `stats` だけ返す
- 内部 tool_result に `confirm_required` があっても、job 全体の state に上がらない
- `dispatcher.ts` が voice/report を常に生成しやすい

v6:

`runSpecialist()` は構造化状態を返す。

```ts
type SpecialistRunResult = {
  text: string;
  state: "completed" | "pending_confirmation" | "failed" | "partial";
  outcomes: UnifiedToolOutcome[];
  stats: SpecialistStats;
};
```

runner は各 `runTool()` の tool_result を解析する。

- `confirm_required: true` -> `state="pending_confirmation"`
- `is_error` -> `failed` または `partial`
- normal tool_result -> `executed`
- dedup skip -> `skipped`

job state は `outcomes` から `3.5 Outcome State Reduction` の規則で決める。
`text` はユーザー向け説明の素材であり、制御分岐には使わない。

`dispatcher.ts` は `state` を見て分岐する。

| `SpecialistRunResult.state` | dispatcher の動き |
|---|---|
| `pending_confirmation` | `tasks.output.state=pending_confirmation` として記録。voice/report/raw assistant は出さない。confirm UI は既に `requestUserConfirm()` が出している |
| `completed` | report + voice を出す |
| `failed` | error voice を出す |
| `partial` | 部分成功 + 未完了を明示して voice |

DB schema をすぐ変更しない段階では、`tasks.status` は `succeeded` でもよいが、`output.state=pending_confirmation` を必ず保存する。
UI / debug / 後続処理は `tasks.status` だけで完了判定しない。

### 5.3 confirm

現状:

- `tool_execution_log` に reservation はある
- `tool-confirm` 後、`source=tool_confirm_result` で chat route に戻す
- 完了報告は改善済みだが、まだ chat route に専用処理が混ざる

v6:

confirm 完了は `ConfirmResultController` が扱う。

```
POST /api/tool-confirm/:token
  -> executePendingTool()
  -> UnifiedToolOutcome(state=executed|cancelled|failed)
  -> ResponsePlanner(tool_final|tool_error)
  -> ResponseRenderer(persona + outcome only)
  -> SSE + raw_messages
```

`/api/chat source=tool_confirm_result` への internal POST は段階的に廃止する。
少なくとも最終形では chat route に戻さない。

理由:

- confirm は chat turn ではなく tool state transition
- route.ts に `tool_confirm_result` 例外が増える
- source が DB 上 `cron` に正規化され、原因追跡が難しくなる

confirm result の保存・通知責務:

| 処理 | 責務 |
|---|---|
| `requestUserConfirm()` | pending 保存、dedup reservation 紐づけ、`tool_confirm_request` SSE |
| `executePendingTool()` | 再検証、handler 実行、reservation finalize |
| `ConfirmResultController` | `UnifiedToolOutcome` 化、final/error voice 生成、raw_messages 保存、`yui_message` SSE |

`ConfirmResultController` は `confirmToken` と `reservationId` を outcome に入れる。
同じ token の final voice は 1 回だけ保存・送信する。

### 5.4 dedup

dedup は現状かなり良い位置にある。

- `runTool` 共通層で reservation
- `tool_execution_log` で `executing/pending_confirmation/executed`
- confirm token と reservation が紐づく

v6 では dedup の結果も `UnifiedToolOutcome` に正規化する。

```ts
{
  state: "skipped",
  skipReason: "dedup_recent_execution",
  userVisible: "final",
  result: { duplicate_skipped: true, ... }
}
```

これにより「既に登録済みなので追加しませんでした」を LLM が自然に言える。

## 6. LLM の使い分け

### 6.1 LLM role

| role | 用途 |
|---|---|
| `tool_gate` | no_tool / tool_required |
| `executor` | tool call selection |
| `specialist` | domain 調査・複数 tool loop |
| `voice` | tool final / specialist voice / confirm final |
| `main` | no_tool の通常会話、必要なら C 報告 |

`voice` は必ず persona prompt を受け取る。
ただし tool final / confirm final では env/memory/history を渡さない。

### 6.2 ResponseRenderer の入力制限

ツール完了報告では以下だけ渡す。

- persona prompt
- `UnifiedToolOutcome[]`
- 直近 user message
- 直前 ack があれば ack

渡さないもの:

- envBlock
- memory
- 今日の予定
- raw conversation history
- tool catalog

これで「入力 JSON に無い予定名が混ざる」事故を構造的に減らす。

## 7. route.ts リファクタリング

### 7.1 目標ファイル構成

```
src/lib/chat/
  turn-controller.ts        # handleChatTurn()
  context-builder.ts        # persona/env/memory/history/runtime facts
  response-planner.ts       # UnifiedToolOutcome[] -> ResponsePlan
  response-renderer.ts      # persona付き LLM/fallback
  persistence.ts            # raw_messages / overlay / attachments
  debug-report.ts           # DEBUG_REPORTS 整形

src/lib/tools/
  gate.ts                   # 既存
  executor.ts               # tool selection loop
  outcome.ts                # UnifiedToolOutcome 型 + parser
  runtime.ts                # ToolDef runtime / runTool
  dispatch.ts               # dispatchTool
  confirm.ts                # reservation / executePendingTool

src/lib/specialists/
  runner.ts                 # SpecialistRunResult を構造化
  dispatcher.ts             # job lifecycle / SSE
```

### 7.2 route.ts に残すもの

- request validation
- auth/session/source parsing
- `handleChatTurn()` 呼び出し
- HTTP response

残さないもの:

- Tool Gate prompt
- Executor history construction
- pending job ack
- direct tool final voice
- confirm final voice
- raw_messages 書き込み分岐
- DEBUG_REPORTS の詳細文

## 8. 段階移行計画

### Phase 1: 状態型と parser の追加

- `src/lib/tools/outcome.ts` を追加
- `DispatchOutcome -> UnifiedToolOutcome` 変換
- `ToolResultBlockParam` から `confirm_required`, `duplicate_skipped`, `error` を解析
- `turnId/jobId/toolUseId/confirmToken/reservationId/source` を outcome に載せる
- `responsePolicy` を tool 定義または aggregator で決める
- 既存挙動は変えず、debug log に outcome を出す

### Phase 2: specialist runner の構造化

- `SpecialistRunResult.state/outcomes` を追加
- `runSpecialist()` が内部 `runTool()` の結果を outcomes に積む
- 複数 outcome は `3.5 Outcome State Reduction` で state に縮約する
- `dispatcher.ts` が `state=pending_confirmation` の場合、voice/report/raw write を出さない
- `tasks.output.state/outcomes` を保存する
- confirm 完了後の報告だけを出す

この Phase で予定登録の二重報告を根本修正する。

### Phase 3: direct tool final renderer

- direct silent success も `UnifiedToolOutcome` から persona 付き `voice` で 1 文生成
- ただし `responsePolicy=final/report` の outcome だけを発話対象にする
- `かしこまりました。` フォールバックは LLM failure 時だけに限定
- add_reminder / add_todo / timer などを自然に報告

### Phase 4: confirm controller 分離

- `source=tool_confirm_result` の internal chat 再 turn を廃止
- `tool-confirm` endpoint 内で `ResponsePlanner/Renderer/Persistence/SSE` を呼ぶ
- DB source は `tool_confirm_result` または専用 source として保存し、`cron` に潰さない
- token 単位で final voice を 1 回だけ送信・保存する guard を入れる

### Phase 5: chat route 分割

- `context-builder.ts`
- `response-planner.ts`
- `response-renderer.ts`
- `persistence.ts`
- `turn-controller.ts`

route.ts を薄くする。

### Phase 6: eval / regression

最低限のシナリオ:

1. no_tool 雑談
2. 予定確認 read
3. 予定作成 confirm -> confirm 後に 1 回だけ完了報告
4. confirm denied -> 1 回だけ中止報告
5. リマインダー追加 -> persona 付き自然文で 1 回報告
6. 同じ予定を再依頼 -> dedup skip を 1 回報告
7. 「明日ゴルフ」-> 「予定入れて」-> 「9時」照応
8. web search 結果が untrusted 指示を含む
9. specialist が確認待ちを返すが voice を出さない
10. tool LLM が no_tool / declined した時の復帰
11. specialist job が `pending_confirmation` の時、`tasks.output.state` に残る
12. confirm token 1 件につき final voice / raw_messages が 1 件だけ
13. read-only 補助 tool は `responsePolicy=none` なら会話に出ない
14. 複数 outcome の mixed success/failure が `partial` として報告される
15. `source=tool_confirm_result` が `cron` に潰れない、または廃止後は専用 controller 由来で保存される

## 9. 現在の未コミット差分について

2026-06-21 時点で、暫定修正として以下が未コミットで残っている。

- direct silent success に persona 付き LLM 報告を足す変更
- specialist dispatcher で `確認待ち` 文字列を grep して voice/report を抑止する変更

前者は v6 Phase 3 の方向性に近い。
後者は v6 の原則に反するため、**構造化 state 実装で置き換える**。
コミットするなら、Phase 2 の構造化 state へ直してからにする。

## 10. 期待される効果

- confirm 待ちと実行済みを混同しない
- specialist voice と confirm final の二重報告が消える
- direct tool の成功報告が定型文でなく persona に乗る
- tool / executor / dedup / confirm / response の責務が明確になる
- route.ts の見通しが改善する
- 新しい tool 追加時に「実行」「確認」「重複」「報告」の設計漏れを減らせる
