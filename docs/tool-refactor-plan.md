# Tool Runtime Refactor Plan

> ステータス: 実行計画  
> 作成日: 2026-06-21  
> 対象: v0.2 以降の Tool Gate / Executor / specialist / confirm / dedup / response pipeline  
> 関連:
> - [tool-agent-state-v6.md](./tool-agent-state-v6.md)
> - [tool-execution-implementation-report.md](./tool-execution-implementation-report.md)
> - [tool-dispatch-redesign.md](./tool-dispatch-redesign.md)
> - [tool-dedup-and-adding-tools.md](./tool-dedup-and-adding-tools.md)

## 0. 目的

ツール実行ロジックは、現時点で実運用できる水準まで到達している。
今後の主作業は、巨大化した `src/app/api/chat/route.ts` を分割し、状態管理・実行・応答・永続化の責務を明確にするリファクタリングである。

この計画書では、今後の作業をフェーズ化し、各フェーズで何を移すか、何をテストするか、何を完了条件にするかを定義する。

## 1. 現在地点

### 実装済み

- Tool Gate による `no_tool` / `tool_required` 判定
- Executor による clean prompt の tool selection
- 直ツール実行の `dispatchTool` / `runTool` 統合
- specialist bridge
- confirm ダイアログ
- confirm 後の isolated LLM final voice
- `tool_execution_log` による dedup reservation
- 削除後の作成 dedup 解除
- `UnifiedToolOutcome` の導入
- direct tool 成功時の persona 付き完了報告
- `route.ts` から以下を分離済み:
  - `src/lib/chat/response-planner.ts`
  - `src/lib/chat/response-renderer.ts`
  - `src/lib/chat/context-builder.ts`
  - `src/lib/chat/persistence.ts`

### 残っている大きな塊

- Tool Gate / retrieval / Executor 呼び出し
- specialist bridge (`onExtraTool`)
- system prompt block 構築
- memory retrieval
- request validation と source/timer handling
- debug report 整形
- `route.ts` 内の旧 inline tool import 残骸

## 2. 方針

1. 動作を変えるリファクタリングを避ける。
   まずは既存挙動を保った切り出しを優先する。

2. 1フェーズ1責務に限定する。
   Tool execution と persistence のような異なる責務を同じコミットで動かさない。

3. 各フェーズはコンテナ内で検証する。
   このアプリは Docker で動いているため、検証は原則として `docker compose exec -T web ...` で行う。

4. 低リスクな分離から進める。
   pure function / DB read の切り出しを先に行い、specialist bridge のような副作用が多い部分は後段に回す。

5. リファクタリング後も debug report を維持する。
   ローカルLLM利用では UI 上の debug report が調査に重要である。

## 3. フェーズ計画

### Phase R1: 応答計画と発話生成の分離

ステータス: 完了
コミット: `e5ebf4b 応答計画と発話生成を分離`

内容:
- Executor outcome から C 応答要否を決める処理を `response-planner.ts` へ分離
- direct tool 完了報告生成を `response-renderer.ts` へ分離
- pending job ack を `response-renderer.ts` へ分離

完了条件:
- `route.ts` が direct tool final voice のプロンプトを持たない
- `npm run typecheck` 成功
- `npm run lint` 成功

### Phase R2: 文脈構築の分離

ステータス: 完了
コミット: `701f2ba チャット文脈構築を分離`

内容:
- `ClientMessage` / `ClientImage` 型を `context-builder.ts` へ移動
- history timestamp load を分離
- `apiMessages` 生成を分離
- `<yui_runtime_context>` 注入を分離
- Executor 用 `recentHistory` / `runtimeFacts` 生成を分離

完了条件:
- `route.ts` が history timestamp query と runtime context injection を直接持たない
- `npm run typecheck` 成功
- `npm run lint` 成功

### Phase R3: 永続化処理の分離

ステータス: 完了  
コミット: `4eb6c37 チャット永続化処理を分離`

内容:
- 画像保存を `persistence.ts` へ分離
- private overlay 保存を分離
- `raw_messages` 保存を分離
- cron/timer assistant 単発保存を分離
- 保存後の food/workout/memory extraction を分離

完了条件:
- `route.ts` が raw/overlay write の詳細を持たない
- private mode でも保存先判定が維持される
- `npm run typecheck` 成功
- `npm run lint` 成功

### Phase R4: System Prompt Builder の分離

ステータス: 完了
コミット: `ed103a8 システムプロンプト構築を分離`

目的:
`route.ts` に残る persona / guard / user profile / health goals / timer guard の system block 構築を `src/lib/chat/system-prompt-builder.ts` に移す。

候補API:

```ts
type BuiltSystemPrompt = {
  systemBlocks: Anthropic.TextBlockParam[];
  envBlock: string;
};

async function buildChatSystemPrompt(args: {
  sessionId: string;
  isTimerMode: boolean;
  registryTools: ToolDef[];
}): Promise<BuiltSystemPrompt>;
```

注意点:
- `envBlock` は specialist judge でも使うため戻り値に含める
- stable system blocks と dynamic context の分離を維持する
- cache_control は最後の stable block に付与する
- timer mode の guard と通常 mode の metadata guard を混ぜない

テスト:
- 雑談が通常応答する
- 予定確認で `envBlock` が judge に渡る
- timer 発火で savedText が指示扱いされない
- typecheck / lint

完了条件:
- `route.ts` から system block 構築の長い push 群が消える
- cache_control の挙動が維持される

### Phase R5: Memory Retrieval Builder の分離

ステータス: 完了
コミット: `bbd33c3 メモリ検索文脈の構築を分離`

目的:
L2/L3/L4 memory retrieval と `memorySection` 構築を `src/lib/chat/memory-context.ts` に移す。

候補API:

```ts
type BuiltMemoryContext = {
  memorySection: string;
  counts: {
    alwaysOn: number;
    recentSummaries: number;
    relevant: number;
  };
  retrieveMs: number;
};

async function buildMemoryContext(args: {
  sessionId: string;
  history: ClientMessage[];
  currentUserMsg: string;
}): Promise<BuiltMemoryContext>;
```

注意点:
- DB失敗時も chat を継続する fail-open を維持する
- response JSON の `memoryCounts` を維持する
- debug / log の計測値を維持する

テスト:
- DB起動時に通常応答
- retrieval failure を一時的に再現しても chat が落ちない
- response の `memoryCounts` が返る
- typecheck / lint

完了条件:
- `route.ts` から `loadAlwaysOnFacts` / `loadRecentSummaries` / `retrieveRelevant` の直呼びが消える

### Phase R6: Tool Orchestrator の分離

ステータス: 完了

目的:
Tool Gate / tool retrieval / Executor / specialist bridge の外枠を `src/lib/chat/tool-orchestrator.ts` に移す。

このフェーズは事故リスクが高いため、2段階に分ける。

#### Phase R6a: Gate + Retrieval + Executor Runner の分離

ステータス: 完了
コミット: `8f973d0 ツール実行オーケストレーターを分離`

内容:
- Tool Gate 判定
- tool candidate retrieval
- `runExecutor()` 呼び出し
- fallback to full catalog
- Executor declined 時の情報返却

残すもの:
- `onExtraTool` specialist bridge は route 側に残す

候補API:

```ts
type ToolOrchestratorInput = {
  currentUserMsg: string;
  recentHistory: Anthropic.MessageParam[];
  runtimeFacts: string;
  registryTools: ToolDef[];
  exposedSpecialistTools: Anthropic.Tool[];
  isUserTurn: boolean;
  mainCtx: ToolContext;
  dispatchLedger: DispatchLedger;
  onExtraTool: ExtraToolHandler;
  completeExecutor: ExecutorCompleteFn;
};

type ToolOrchestratorResult = {
  gateDecision: ToolGateDecision;
  runExec: boolean;
  exec: ExecutorResult | null;
  debugLines: string[];
  didMainFallbackRequired: boolean;
};
```

テスト:
- no_tool 雑談
- 予定作成
- duplicate skip
- tool retrieval で候補が狭まった時も fallback が効く

#### Phase R6b: Specialist Bridge の分離

ステータス: 完了
コミット: `a73a12c Specialist Bridgeをオーケストレーターへ統合`

内容:
- `ask_schedule_specialist` の recent target delete 解決
- `judgeDispatch`
- `dispatchSpecialistJob`
- `pendingJobs` 追加

注意点:
- 「今入れた予定を削除」系の event_id 解決を壊さない
- `envBlock` を judge に渡す
- `conversationHistory` を specialist job に渡す
- `yuiAckText=""` を維持する

テスト:
- 予定確認 read
- 予定作成 confirm
- 作成直後の「その予定を削除」
- pending confirmation の二重報告が出ない

完了条件:
- `route.ts` に `onExtraTool` の詳細実装が残らない
- `pendingJobs` / `executedTools` / debug lines が orchestrator result 経由になる

### Phase R7: Request Parser / Turn Controller の分離

ステータス: 完了

目的:
HTTP request parsing と chat turn orchestration を分ける。

候補ファイル:
- `src/lib/chat/request-parser.ts`
- `src/lib/chat/turn-controller.ts`

#### Phase R7a: Request Parser の分離

ステータス: 完了
コミット: `3d906a0 チャットリクエスト解析を分離`

#### Phase R7b: Turn Helper の追加分離

ステータス: 完了
コミット: `a045261 ツール実行要約を分離`

役割:
- `request-parser.ts`: body validation / source / timerEvent / message normalization
- `turn-controller.ts`: route の主要フローを関数化
- `route.ts`: `POST()` と error handling の薄い wrapper

テスト:
- `messages` 配列形式
- `message` 単発形式
- timer source
- 画像添付
- invalid payload

完了条件:
- `src/app/api/chat/route.ts` が概ね 300〜500 行以内
- HTTP固有処理以外が `src/lib/chat/` に寄る

### Phase R8: Dead Import / Legacy Tool Cleanup

ステータス: 完了
コミット: `aaa04d3 チャットルートの未使用importを整理`

目的:
`route.ts` に残る旧 inline tool 時代の未使用 import を整理する。

注意点:
- lint warning を一気に消すだけの機械作業だが、参照が特殊なものもあるため typecheck 必須
- 機能変更とは別コミットにする

テスト:
- typecheck
- lint warning 件数が減ること

完了条件:
- `route.ts` の未使用 import warning が原則 0
- `periodic/mail-poll.ts` の既存 warning も解消済み

### Phase R9: Regression / Eval

ステータス: 完了

目的:
リファクタリング完了後に、ツール実行の主要シナリオを通しで確認する。

手動シナリオ:

1. 雑談: 「元気？」
2. read: 「明日の予定を教えて」
3. create confirm: 「明日20時にテスト予定を入れて」
4. confirm approve: ダイアログ許可後、完了報告が1回だけ出る
5. delete recent: 「その予定を削除して」
6. confirm approve: 削除後、同じ予定を再作成できる
7. dedup skip: 同じ予定を連続作成依頼してスキップされる
8. reminder: 「15時にコーラ買うリマインダー」
9. no_tool: お礼や雑談で tool が走らない
10. pending UI: specialist job 完了後に「確認中...」が残らない
11. private mode: raw_messages に保存されず overlay に表示される
12. image: 画像添付が保存され、通常応答が返る

DB確認:

```sql
SELECT id, tool_name, status, confirm_token, args
FROM tool_execution_log
ORDER BY id DESC
LIMIT 20;
```

```sql
SELECT id, session_id, source, role, content, tool_summary
FROM raw_messages
ORDER BY id DESC
LIMIT 20;
```

Docker検証:

```bash
docker compose exec -T web npm run typecheck
docker compose exec -T web npm run lint
docker compose restart web
docker compose logs --since 1m web
```

### Phase R10: Tool Runtime Auto Eval

ステータス: 初期導入完了
コミット: `b5937fd ツール実行の自動evalを追加`

目的:
手動回帰だけに依存せず、ツール実行基盤の決定的なロジックを固定 fixture で検証する。
初期版では LLM / DB / 外部 API に依存しない範囲を対象にする。

実装:
- `scripts/tool-runtime-eval.ts`
- `npm run eval:tools`

対象:
- request parser
  - single message
  - messages array
  - assistant `toolSummary` の保持
  - 画像添付 marker
  - timer event の untrusted wrap
  - invalid payload
- response planner
  - action missed
  - executor declined fallback
  - direct final outcome
  - dedup skip final outcome
- tool gate
  - LLM JSON 出力の正規化
  - no_tool の wait policy 強制
  - invalid decision の拒否
  - action intent fallback
- tool summary
  - reminder / specialist query の要約
- dedup
  - 終日 date anchor
  - dateTime の UTC 分単位正規化
  - invalid dateTime の拒否
  - title lexical 正規化
  - calendar / reminder / timer の dedup key fixture

次の拡張は R13 以降にフェーズ化して実施する。

### Phase R12: LLM-backed Gate Fixture Eval

ステータス: 実装完了

目的:
モデル変更・プロンプト変更で Tool Gate の分類が退行していないかを、実モデル呼び出しで検出する。
通常の決定的 eval とは分離し、ローカルLLM / API が利用できる環境で任意実行する。

実装:
- `scripts/tool-gate-llm-eval.ts`
- `npm run eval:gate-llm`

対象:
- 雑談 no_tool
- 予定確認 read
- 予定登録 mutate
- 履歴参照を含む予定登録 mutate
- 音楽制御 transport

### Phase R11: Tool DB Health Check

ステータス: 実装完了

目的:
手動で確認していた `tool_execution_log` / `tasks` の状態を、読み取り専用の運用チェックとして自動化する。
ツール実行後に「宙に残った確認待ち」「長時間 running task」「直近 failed」を即座に検出できるようにする。

実装:
- `scripts/tool-db-health-check.ts`
- `npm run health:tools`

判定:
- `tool_execution_log.status='pending_confirmation'` が一定時間を超えて残っていないこと
- `tasks.status='running'` が一定時間を超えて残っていないこと
- 直近 window に `tool_execution_log.status='failed'` / `tasks.status='failed'` がないこと
- 現在の pending / executing 件数と直近 execution status 分布を診断表示する

### Phase R13: Confirm Recovery Fixture

ステータス: 実装完了

目的:
確認ダイアログ境界で起きる二重報告・確認中表示の残留・誤完了報告を、LLM / DB / 外部 API に依存しない fixture で固定する。

実装予定:
- `scripts/tool-runtime-eval.ts` に confirm result / outcome / response planner の fixture を追加
- `confirm-result-controller.ts` の fallback reply / toolSummary 生成を pure function として検証できるようにする

対象:
- `confirm_required` tool result が `pending_confirmation` / `confirmation` として扱われる
- pending confirmation は `finalDirectOutcomes` に入らず、完了報告候補にならない
- 承認成功時の fallback reply が input.result の事実だけで生成される
- 拒否時の fallback reply が未実行として生成される
- confirm final の toolSummary が `completed` / `not_completed` と event id / title / start を保持する

完了条件:
- `npm run eval:tools` に confirm fixture が含まれる
- `typecheck` / `lint` が通る
- フェーズ単位でコミットする

### Phase R14: DB Integration Eval

ステータス: 実装完了

目的:
実 DB を使い、`tool_execution_log` / `tasks.output` / `raw_messages.tool_summary` の整合を自動確認する。
外部 API は叩かず、読み取り専用チェックまたは専用 fixture データだけを対象にする。

実装予定:
- `scripts/tool-db-integration-eval.ts`
- `npm run eval:tool-db`

対象:
- pending / executing が残留していない
- 直近 confirm final の `tasks.output.confirmFinal` が token / state / success / result を持つ
- confirm final の `raw_messages.source='tool_confirm_result'` に内部ログが混入していない
- 同一 token の final voice が重複保存されていない

完了条件:
- 実運用 DB に対して安全な読み取り専用チェックである
- 失敗時に該当 id / token / session を表示する
- `health:tools` と役割が重複しすぎない

### Phase R15: Dedup Precision / Recall Fixture

ステータス: 実装完了

目的:
Dedup の「弾くべき重複」と「許可すべき別件」を fixture 化し、閾値や anchor 変更時の退行を検出する。

実装予定:
- lexical fallback 用の pure 判定を切り出して eval する
- embedding 依存の precision / recall は任意実行の LLM/embedding-backed eval として分離する

対象:
- 同一 calendar / 同一時刻 / 同一タイトルは duplicate
- 同一時刻でも別タイトルは lexical fallback では duplicate にしない
- 同一タイトルでも別開始時刻は duplicate にしない
- 削除後 `cancelled` の create reservation は再作成を妨げない

完了条件:
- pure fixture は `eval:tools` に含める
- embedding-backed fixture は任意コマンドに分離する

### Phase R16: Tool Metrics / Observability

ステータス: 実装完了

目的:
ユーザーの手動報告に頼らず、Gate / Executor / Dedup / Confirm の退行を運用ログ・DB集計から検出できるようにする。

実装予定:
- `llm_events` または専用集計で role=tool_gate の latency / fallback / parse_error を確認
- `tool_execution_log` の status 分布と skip 率を確認
- confirm abandon / denied / executed 比率を確認
- `scripts/tool-observability-report.ts`
- `npm run observe:tools`

対象:
- Gate parse_error / llm_error
- action missed
- dedup skipped / failed
- confirm pending / cancelled / executed
- stage latency p50/p95

完了条件:
- 開発者が1コマンドで直近状態を確認できる
- UI debug report と DB metrics の責務を分ける

### Phase R17: Crash Recovery / Reconciliation Design

ステータス: 実装完了

目的:
プロセス再起動や外部 API 成功直後のクラッシュで、pending / executing / external side effect が宙に残る問題への設計を固める。

実装予定:
- 現状の fail-open / cleanup / dedup 保持の限界を整理
- GCal create / delete の冪等キーまたは reconciliation 方針を設計
- 実装可能な backstop job を小さく入れるか判断する
- `docs/tool-crash-recovery-reconciliation.md`

対象:
- confirm 承認後、handler 成功から `markExecuted` までのクラッシュ
- `executing` reservation の残留
- GCal create 成功後の task final 未反映
- delete 成功後の create dedup cancel 未反映

完了条件:
- 実装する/しないの境界が設計書に残っている
- 実装する場合は destructive でない検証から始める

### Phase R18: Tool Domain Integration Eval

ステータス: 実装完了

目的:
予定・リマインダー以外の主要ツールドメインも、実 tool handler と実 DB / 外部 API を使って自動回帰確認する。

実装:
- `scripts/tool-domain-integration-eval.ts`
- `npm run eval:tool-domains`
- `npm run eval:tool-domains:strict`

対象:
- TODO: add / search / complete / delete
- Note: save / search / delete
- Contact: add / search / find / append note / delete
- Reminder: add / list / delete
- Gmail: list labels / search
- Music: now playing / devices
- News: list / search / pin / unpin
- Project: add / list / archive
- Health: set goal / list goals / delete goal
- Google Calendar: create / get / list / delete

方針:
- テスト用 `runId` / `sessionId` を付けて作成し、最後に cleanup する
- DB 系ツールは実 DB にテストデータを作成し、同一 id / identifier を削除する
- GCal は実 primary calendar に短時間のテスト予定を作成し、同一 event id を削除する
- Gmail / Music は外部 API の read-only 呼び出しとして、破壊的操作を行わない
- 通常コマンドは外部API未設定なら skip。strict は外部API未設定を失敗扱いにする
- 失敗時も best-effort cleanup を走らせる

### Phase R19: Tool Reconciliation Dry-run

ステータス: 実装完了

目的:
プロセス再起動や外部 API 成功直後のクラッシュで、`tool_execution_log` / `tasks` / confirm final の状態がずれた候補を検出する。
外部 API の mutation は replay せず、まず読み取り専用の dry-run report と fixture eval で検出能力を固定する。

実装予定:
- `scripts/tool-reconciliation-report.ts`
- `scripts/tool-reconciliation-eval.ts`
- `npm run reconcile:tools`
- `npm run eval:tool-reconcile`

対象:
- 古い `pending_confirmation`
- confirm token 未紐付けの古い `pending_confirmation`
- 古い `executing` reservation
- 古い `tasks.status='running'`
- `tool_execution_log.status='executed'` だが `tasks.output.confirmFinal` が無い confirm token
- `tasks.output.confirmFinal.success=true` だが executed reservation が見つからない confirm token

方針:
- 初期実装は read-only。外部 API の再実行・補償・自動成功化はしない
- 各 issue に `severity` / `action` / 対象 id を出す
- eval は専用 `runId` の fixture row だけを作成し、cleanup する
- 将来 `--fix` を入れる場合も、まず stale pending の cancel のような副作用が DB 内に閉じるものだけを対象にする

完了条件:
- `reconcile:tools` が現状DBで実行できる
- `eval:tool-reconcile` が fixture の不整合を検出できる
- typecheck / lint / 既存 eval が通る

### Phase R20: Tool Reconciliation Safe Fix

ステータス: 実装完了

目的:
R19 で検出できるようになった復旧候補のうち、外部 API の side effect に触れず DB 内で安全に修復できるものだけを `reconcile:tools --fix` で処理する。

実装予定:
- `reconcile:tools --fix`
- `reconcile:tools --json --fix`
- `eval:tool-reconcile` に fix 前後の fixture 検証を追加

fix 対象:
- 古い `pending_confirmation` を `cancelled` にする
- confirm token 未紐付けの古い `pending_confirmation` を `cancelled` にする
- 古い `tasks.status='running'` を `failed` にし、error に reconciliation reason を残す

fix しない対象:
- 古い `executing` reservation
- `executed` reservation はあるが `confirmFinal` が無いもの
- `confirmFinal` はあるが executed reservation が無いもの
- 外部 API の replay / compensate / backfill

完了条件:
- `--fix` なしは従来どおり read-only
- `--fix` は修復対象件数とスキップ対象件数を表示する
- fixture eval で fix 後に error 系 issue が消える
- warn 系 issue は必要に応じて残る
- typecheck / lint / 既存 eval が通る

### Phase R21: Dedup Embedding Precision / Recall Eval

ステータス: 実装完了

目的:
dedup 設計の主目的である embedding 類似判定について、実 embedding service / 実 DB / `dedupCheckAndReserve` を使った回帰テストを追加する。
R15 の pure fixture では見えていなかった「文字違いの同一意図を弾く」「同一 anchor でも別件は通す」を検証する。

実装予定:
- `scripts/tool-dedup-embedding-eval.ts`
- `npm run eval:dedup-embed`

対象:
- 同一 calendar / 同一開始終了 / 同義タイトルは duplicate skip になる
- 同一 calendar / 同一開始終了 / 別タイトルは reservation される
- skipped / executed / executing の記録が fixture scope 内で期待どおり残る
- cleanup で fixture scope の `tool_execution_log` を削除する

方針:
- 実 GCal handler は呼ばない。外部カレンダーには書き込まない
- 実 embedding service と pgvector cosine 経路は使う
- embedding service 未起動は失敗として扱う
- 閾値調整時はこの eval を先に見る

完了条件:
- `eval:dedup-embed` が Docker 内で通る
- typecheck / lint / 既存 `eval:tools` が通る

### Phase R22: Executor LLM Tool Selection Eval

ステータス: 実装完了

目的:
実 LLM の Executor が、ユーザー発話と短い履歴から期待ツールを選び、最低限必要な引数を生成できるかを回帰テストする。
R18 の handler CRUD では見えない「モデル依存のツール選択・引数生成」の退行を検出する。

実装予定:
- `scripts/tool-executor-llm-eval.ts`
- `npm run eval:executor-llm`

対象:
- 予定作成: `gcal_create_event` と summary/start/end
- 予定削除: `gcal_delete_event` と event_id
- リマインダー作成: `add_reminder` と title/base_at
- TODO作成: `add_todo` と title
- メモ保存: `save_note` と body_md
- 履歴参照つき予定作成: 会話履歴から title/location/start を補う

方針:
- 実 LLM / 実 `runExecutor` を使う
- 実 tool handler は呼ばず、ToolDef の name / description / schema を保った mock handler に差し替える
- GCal / DB / 外部API への副作用は発生させない
- ローカルLLM差を考慮し、初期しきい値は 5/6 pass とする
- 各 fixture で実際の tool name / input を表示し、失敗時にプロンプトやdescription改善へつなげる

完了条件:
- `eval:executor-llm` が Docker 内で実行できる
- 期待ツールと必須引数の pass/fail が表示される
- typecheck / lint / 既存 `eval:tools` が通る

### Phase R23: CI / Local Gate Integration

ステータス: 実装完了

目的:
手動で増やしてきた eval を、変更時に必ず回る決定的ゲートと、環境依存の任意ゲートに分ける。
DB / 外部 API / ローカル LLM が無い CI でも最低限の退行検出を行い、開発環境ではモデル依存・統合系もまとめて実行できるようにする。

実装予定:
- `npm run check`
- `npm run check:tool-model`
- `npm run check:tool-integration`
- `npm run check:tool-integration:strict`
- `.github/workflows/ci.yml`

分類:
- `check`: typecheck / lint / deterministic `eval:tools`
- `check:tool-model`: Gate LLM / Executor LLM / embedding dedup
- `check:tool-integration`: 実 DB / health / reconciliation / domain handler eval
- `check:tool-integration:strict`: 外部 API skip を許さない手元向け strict

方針:
- CI は DB / LLM / OAuth / embedding service を要求しない
- LLM と外部 API の揺らぎは通常CIに入れず、手元または夜間ジョブ候補にする
- 将来 DB service と pgvector を CI に用意できたら、`check:tool-integration` の一部をCIに昇格する

完了条件:
- `npm run check` が Docker 内で通る
- `check:tool-model` と `check:tool-integration` の使い分けが package script で明確になる
- GitHub Actions が `npm run check` を実行する

### Phase R24: Reconciliation Historical Warning Suppression

ステータス: 実装完了

目的:
`reconcile:tools` に残る過去データ由来の `confirm_final_without_executed_reservation` warn を整理し、新しい異常を埋もれさせない。

確認結果:
- 6月21日の warn は `tool_execution_log` 導入/保持前の confirm final 履歴で、reservation row が存在しない
- 6月23日の warn は作成後に削除された予定で、`gcal_create_event` reservation が `cancelled` になっている正常ケース

実装予定:
- confirm final / reservation 不一致の検出対象を直近 window に限定する
- window は `TOOL_RECONCILE_CONFIRM_FINAL_HOURS` で変更可能、既定 24h
- `gcal_create_event` の successful confirm final は、reservation が `executed` または `cancelled` なら正常扱いにする
- fixture eval に old historical row と cancelled-create row を追加する

完了条件:
- 現DBで `reconcile:tools` の既知 warn が消える
- 古い historical warn は通常検出から除外される
- 新しい no-log confirm final は引き続き warn になる
- 削除済み create reservation (`cancelled`) は warn にならない

### Phase R25: Executor LLM Eval Fixture Expansion

ステータス: 実装完了

目的:
R22 の最小 Executor LLM eval を拡張し、read 系、曖昧 mutation の抑止、削除安全性、他ドメインのツール選択を検証する。

実装予定:
- `scripts/tool-executor-llm-eval.ts` の fixture 拡充
- `expectedTool: null` による no_tool / no execution 検証
- pass threshold を fixture 数に合わせて更新

追加対象:
- 予定 read: `gcal_list_events`
- 予定検索: `gcal_list_events` + `q`
- 曖昧予定作成抑止: 日時不足で作成しない
- 曖昧リマインダー抑止: 時刻不足で作成しない
- event_id なし削除抑止: `gcal_delete_event` を直接呼ばない
- Gmail search
- music now playing
- news list
- contact search

完了条件:
- `eval:executor-llm` が拡張fixtureで通る
- 副作用なしの mock handler 方針を維持する
- typecheck / lint / `check:tool-model` が通る

## 4. コミット方針

- フェーズ単位でコミットする
- コミットメッセージは日本語
- 作業外ファイルは含めない
- `docker-compose.yml.pre-pg18.bak` は現時点では未追跡の作業外ファイルとして扱う

推奨メッセージ例:

- `システムプロンプト構築を分離`
- `メモリ文脈構築を分離`
- `ツール実行オーケストレーションを分離`
- `チャットリクエスト解析を分離`
- `チャットルートの未使用importを整理`

## 5. 完了定義

リファクタリング全体の完了条件:

- `route.ts` が薄い HTTP wrapper + turn controller 呼び出しに近づいている
- 状態判定が自然文 grep ではなく `UnifiedToolOutcome` / task output / dedup status に寄っている
- confirm / specialist / direct tool の完了報告が二重にならない
- 予定作成・削除・再作成が安定して動く
- typecheck / lint が通る
- 主要手動シナリオ R9 が通る
