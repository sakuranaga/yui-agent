# Tool Use Implementation Report

最終更新: 2026-06-23

## 結論

v0.2 以降のツール利用リファクタリングは、主要な実行ロジックについて完了扱いにできる。

現在の設計は、人格を持つ会話生成と、ツール要否判定・ツール選択・実行・結果報告を分離している。弱めのローカル LLM を前提にしても、誤実行と二重報告を抑えるための状態管理、dedup、confirm、eval が入っている。

残る改善余地は、より広い自動 eval コーパス、CI 上の DB/LLM 統合ゲート、分散プロセス化した場合の Redis/pubsub/lock 設計である。単一ユーザー・単一ホスト前提の常用エージェントとしては、基盤部分は実用段階に近い。

## 実装方針

ツール利用は次の責務に分離した。

- `Tool Gate`: 最新発話と短い履歴から、ツールが必要かだけを判定する。
- `Tool Retrieval`: 全ツールをそのまま渡さず、発話に関連する候補へ絞る。
- `Executor`: 人格なしの clean prompt でツール名と引数だけを選ぶ。
- `Dispatch`: direct tool / confirm / specialist bridge を構造化された outcome に変換する。
- `Dedup`: 同一 mutation の重複実行を reservation と embedding/lexical 判定で抑える。
- `Confirm`: destructive / external send 系を pending にし、ユーザー許可後に Phase B で実行する。
- `Reporter`: 実行結果を `UnifiedToolOutcome` と task state から報告する。
- `Reconciliation`: pending/running/confirmFinal の不整合候補を検出し、安全なものだけ修復する。

## モジュール関係

```mermaid
flowchart LR
  ChatRoute["app/api/chat/route.ts"]
  Context["chat/context-builder.ts"]
  Gate["tools/gate.ts"]
  Retrieval["tools/tool-index.ts"]
  Orchestrator["chat/tool-orchestrator.ts"]
  Executor["tools/executor.ts"]
  Runtime["tools/runtime.ts"]
  Dispatch["tools/dispatch.ts"]
  Outcome["tools/outcome.ts"]
  Dedup["tools/dedup-guard.ts"]
  Confirm["tools/confirm.ts"]
  ConfirmResult["tools/confirm-result-controller.ts"]
  Planner["chat/response-planner.ts"]
  Renderer["chat/response-renderer.ts"]
  Specialist["jobs/dispatcher.ts"]
  DB[("Postgres")]
  Cache[("Valkey")]
  SSE["jobs/events.ts"]

  ChatRoute --> Context
  ChatRoute --> Orchestrator
  Orchestrator --> Gate
  Orchestrator --> Retrieval
  Orchestrator --> Executor
  Executor --> Dispatch
  Dispatch --> Runtime
  Dispatch --> Outcome
  Runtime --> Dedup
  Runtime --> Confirm
  Runtime --> DB
  Confirm --> Cache
  Confirm --> DB
  Confirm --> SSE
  Confirm --> ConfirmResult
  ConfirmResult --> DB
  ConfirmResult --> SSE
  Executor --> Specialist
  Specialist --> DB
  Specialist --> SSE
  ChatRoute --> Planner
  ChatRoute --> Renderer
```

## 通常ツール実行

```mermaid
sequenceDiagram
  participant U as User
  participant API as Chat Route
  participant G as Tool Gate
  participant R as Retrieval
  participant E as Executor
  participant D as Dispatch
  participant T as Tool Handler
  participant P as Response Planner

  U->>API: メッセージ送信
  API->>G: 最新発話 + 短い履歴
  G-->>API: no_tool / tool_required
  alt no_tool
    API-->>U: 通常会話応答
  else tool_required
    API->>R: ツール候補検索
    R-->>API: 候補ツール
    API->>E: clean prompt + candidates
    E->>D: tool_use
    D->>T: handler実行
    T-->>D: result
    D-->>E: UnifiedToolOutcome
    E-->>API: ExecutorRunResult
    API->>P: outcome集約
    P-->>API: final / report / pending
    API-->>U: 結果応答
  end
```

## Confirm Phase A/B

```mermaid
sequenceDiagram
  participant U as User
  participant API as Chat Route
  participant E as Executor
  participant RT as Runtime
  participant C as Confirm
  participant Cache as Valkey
  participant DB as Postgres
  participant SSE as SSE
  participant H as Tool Handler

  U->>API: 予定追加/削除など
  API->>E: tool_required
  E->>RT: confirm対象 tool_use
  RT->>DB: dedup reservation pending_confirmation
  RT->>C: requestUserConfirm
  C->>Cache: pending token保存
  C->>SSE: tool_confirm_request
  C-->>RT: confirm_required token
  RT-->>API: pending_confirmation outcome
  API-->>U: 確認待ち

  U->>API: confirm approve/deny
  API->>C: applyConfirmDecision
  alt approve
    API->>C: executePendingTool
    C->>H: handler実行
    H-->>C: result
    C->>DB: reservation executed + confirmFinal completed
    C->>SSE: tool_confirm_result success
  else deny
    C->>DB: reservation cancelled + confirmFinal cancelled
    C->>SSE: tool_confirm_result denied
  end
```

## Specialist Bridge

```mermaid
sequenceDiagram
  participant E as Executor
  participant O as Tool Orchestrator
  participant J as Dispatch Judge
  participant Q as Job Dispatcher
  participant DB as Postgres tasks
  participant S as Specialist Runner
  participant SSE as SSE

  E->>O: ask_*_specialist tool_use
  O->>J: dispatch可否判定
  alt skip
    J-->>O: skip
    O-->>E: skipped/report
  else dispatch
    O->>Q: dispatchSpecialistJob
    Q->>DB: task pending
    Q-->>O: jobId
    O-->>E: executed/silent
    E-->>O: async_dispatched
    Q->>S: background実行
    S-->>Q: factual result
    Q->>DB: task succeeded/failed
    Q->>SSE: yui_message/report_update
  end
```

## Eval / Regression

現在の主要ゲートは次の通り。

- `npm run check`: typecheck / lint / deterministic runtime eval
- `npm run check:tool-model`: Gate LLM / Executor LLM / Orchestrator LLM / Dedup embedding
- `npm run check:tool-integration`: DB state / reconciliation / confirm Phase B / health / domain integration

追加された重要 eval:

- R21: `eval:dedup-embed`
- R22/R25: `eval:executor-llm`
- R26: `eval:tool-orchestrator-llm`
- R27: `eval:tool-confirm-phaseb`
- R28: `eval:tools` 内の specialist bridge fixture

## 完了基準

ツール利用リファクタリングは、以下を満たした時点で完了とする。

- ツール要否、選択、実行、confirm、report が分離されている
- mutation の重複実行が dedup で抑止される
- destructive / external send は confirm Phase B でのみ実行される
- pending confirmation は完了報告候補にならない
- event_id なし削除は直接削除に進まない
- Executor / Orchestrator / Confirm Phase B / Specialist bridge の回帰evalがある
- `npm run check` と `npm run check:tool-model` が通る

## 残リスク

- 実 LLM eval はモデル依存なので、ローカルモデル変更時は `check:tool-model` を必ず再実行する。
- `check:tool-integration` は実 DB / OAuth / 外部依存の状態に左右されるため、CI の必須ゲートにはしていない。
- 複数プロセス構成にする場合、SSE と confirm pending の状態共有を Redis pub/sub などへ拡張する必要がある。
- 画像入力を前提にしたツール起動は、現状の Executor 履歴では十分に扱えていない。
