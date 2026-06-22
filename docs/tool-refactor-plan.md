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
コミット: `TBD システムプロンプト構築を分離`

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
コミット: `TBD メモリ検索文脈の構築を分離`

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
コミット: `TBD ツール実行オーケストレーターを分離`

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
コミット: `TBD Specialist Bridge をオーケストレーターへ統合`

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

ステータス: 未着手

目的:
HTTP request parsing と chat turn orchestration を分ける。

候補ファイル:
- `src/lib/chat/request-parser.ts`
- `src/lib/chat/turn-controller.ts`

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

ステータス: 未着手

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
- `periodic/mail-poll.ts` の既存 warning は別途対応

### Phase R9: Regression / Eval

ステータス: 未着手

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
