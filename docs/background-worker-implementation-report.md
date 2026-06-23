# Background Worker Implementation Report

Date: 2026-06-23

## Summary

Web hot path から scheduler / maintenance / specialist job / confirm Phase B / post-persist extraction / selected heavy helper jobs を分離し、plain `tsx` worker process に移した。

主目的は以下。

- Next dev server の HMR / compile / request lifecycle に background processing を巻き込まない
- user turn 中の proactive 発話を queue し、会話への割り込みを抑制する
- SSE 未接続・Web再起動中でも user-facing result を durable outbox に残す
- worker crash 後に stuck job を recovery できるようにする
- Docker内で worker heartbeat / queue / periodic 状態を観測できるようにする

## Module Map

```mermaid
flowchart LR
  Browser[Browser / UI] --> Web[Next Web]
  Web --> ChatAPI[/api/chat]
  Web --> ConfirmAPI[/api/tool-confirm/:token]
  Web --> WorkerStatus[/api/worker/status]

  ChatAPI --> Raw[(raw_messages)]
  ChatAPI --> BJ[(background_jobs)]
  ChatAPI --> Outbox[(events_outbox)]
  ConfirmAPI --> ConfirmJobs[(tool_confirm_jobs)]

  Worker[worker process<br/>npm run worker] --> Scheduler[Scheduler Owner]
  Worker --> Maintenance[Maintenance Loop]
  Worker --> Specialist[Specialist Job Loop]
  Worker --> ConfirmExec[Confirm Execution Loop]
  Worker --> Jobs[Generic Background Job Loop]
  Worker --> Recovery[Recovery Loop]
  Worker --> Heartbeat[(worker_heartbeats)]

  Scheduler --> Periodic[(periodic_state)]
  Specialist --> Tasks[(tasks)]
  Specialist --> Outbox
  ConfirmExec --> ConfirmJobs
  ConfirmExec --> Outbox
  Jobs --> BJ
  Jobs --> Memory[(memory_chunks / food_logs / workout_logs / mail)]
  Recovery --> BJ
  Recovery --> ConfirmJobs
  Recovery --> Tasks

  Outbox --> SSE[/api/chat/stream]
  SSE --> Browser
  WorkerStatus --> Heartbeat
  WorkerStatus --> BJ
  WorkerStatus --> Periodic
```

## Main Sequences

### Chat Post-persist Jobs

```mermaid
sequenceDiagram
  participant U as User
  participant W as Web /api/chat
  participant DB as Postgres
  participant WK as Worker

  U->>W: chat message
  W->>DB: persist raw turn
  W->>DB: enqueue background_jobs(chat.post_persist)
  W-->>U: reply
  WK->>DB: claim pending job (SKIP LOCKED)
  WK->>DB: run food/workout/memory extraction
  WK->>DB: mark succeeded or failed
```

### Confirm Phase B

```mermaid
sequenceDiagram
  participant UI as Confirm Dialog
  participant W as Web /api/tool-confirm
  participant DB as Postgres
  participant WK as Worker
  participant EXT as External API
  participant SSE as SSE Outbox

  UI->>W: confirmed / denied
  W->>DB: update tool_confirm_jobs decision
  W-->>UI: 202 accepted
  WK->>DB: claim confirmed job
  WK->>EXT: execute tool handler
  WK->>DB: finalize dedup + confirm state
  WK->>SSE: durable yui_message / result
```

### Durable Outbox

```mermaid
sequenceDiagram
  participant Producer as Worker/Web Producer
  participant DB as events_outbox
  participant Valkey as Wake-up Pub/Sub
  participant SSE as /api/chat/stream
  participant UI as Browser

  Producer->>DB: insert durable event
  Producer->>UI: direct push if connected
  alt not connected
    Producer->>Valkey: publish wake-up
  end
  UI->>SSE: connect/reconnect
  SSE->>DB: drain undelivered events
  SSE-->>UI: send event
  SSE->>DB: mark delivered
```

## Current Job Stores

- `tasks`: specialist task domain state and report output.
- `tool_confirm_jobs`: confirm pending/decision/execution state.
- `background_jobs`: generic worker queue for post-persist and helper jobs.
- `events_outbox`: durable delivery queue for user-facing SSE events.
- `worker_heartbeats`: worker liveness.
- `periodic_state`: scheduler module last run / fired state.

## Recovery Policy

- `background_jobs.running`: retry by returning to `pending` if attempts remain.
- `background_jobs.running` max attempts exceeded: mark `failed`.
- `tool_confirm_jobs.running`: mark `failed`; do not auto replay external mutation.
- `tasks.specialist_query.running`: mark `failed`; do not auto replay to avoid duplicate speech / side effects.

## Observability

Commands:

```bash
docker compose exec -T web npm run observe:worker
docker compose exec -T web npm run observe:tools
docker compose exec -T web npm run health:tools
```

HTTP:

```bash
GET /api/worker/status
```

The endpoint returns worker heartbeat, queue summary, confirm summary, specialist task summary, outbox pending counts, and periodic state.

## Remaining Work

- Manual mail poll / fetch bodies job migration.
- Explicit `diary.write` job handler split, if scheduler direct execution becomes too opaque.
- Spotify polling heavy follow-up split.
- Transactional enqueue between raw message persist and `chat.post_persist` job.
- Real UI smoke test for image summary / music prefetch / mail curate.
