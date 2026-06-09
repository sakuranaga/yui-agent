# プロジェクト ワークスペース + 作業ログ + タスク実行エージェント 設計書

## 1. 背景と目的

現状の Yui は **「整理係」** にはなれているが、**「仕事を任せられる人」** にはなって
いない。TODO 登録 / カレンダー / メール対応 はできるが、「T-11 の見積書作っとい
て」と言って成果物が手元に届く流れが無い。

問題は 3 つに分解できる:
1. **保存場所が無い**: Yui が作った見積書・議事録・調査メモを置く場所が無い
2. **作業記録が無い**: 「何をどこまでやったか」を時系列で見る場所が無い (= memory_chunks
   は granular な事実集積であって、project の時系列ではない)
3. **実行系が無い**: 「T-11 やっといて」を受けてプロジェクト全体を調査 → 不足情報を聞いて
   くる → 自律的に作業 → 成果物保存 → 報告、というループを担うエージェントが無い

本設計書はこの 3 つの新システムを **段階的に** 導入する全体プラン。

実装は **2026-06-15 以降の Claude Agent SDK サブスク解禁** を待ってから本格着手する。
それまでに Phase 1 (= workspace + files) は先行できる可能性あり。

---

## 2. 全体像

```
┌────────────────────────────────────────────────────────┐
│  ご主人様: 「T-11 の見積書作っといて」                  │
└────────────────────────────────────────────────────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │  Task Execution Agent (新規)    │
        │  - project context 集計          │
        │  - 不足情報 質問ループ           │
        │  - 自律実行 (web / file / todo) │
        └───────────────────────────────┘
              │              │             │
              ▼              ▼             ▼
   ┌─────────────────┐ ┌──────────┐ ┌──────────────┐
   │ Project Workspace│ │ Work Log │ │ 既存資産     │
   │  (新規 ファイル) │ │ (新規)   │ │ todos /       │
   │                  │ │          │ │ project_links │
   │ /workspaces/     │ │ project  │ │ /memory_      │
   │ <slug>/...       │ │ + task   │ │ chunks /      │
   │                  │ │ + actor  │ │ mail / diary  │
   │ project_files DB │ │ + kind   │ │               │
   └─────────────────┘ └──────────┘ └──────────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │  Project Hub Modal (拡張)       │
        │  [概要][Todos][予定][メール]    │
        │  [日記][ファイル ★][作業ログ ★] │
        └───────────────────────────────┘
```

---

## 3. 新規データモデル

### 3.1 `project_files` (Phase 1)

ファイル本体は filesystem、metadata だけ DB。

```sql
CREATE TABLE project_files (
  id              BIGSERIAL PRIMARY KEY,
  project_id      BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path            TEXT NOT NULL,                  -- workspace 内相対パス ("見積書/T-11.md")
  kind            TEXT NOT NULL,                  -- "markdown" | "text" | "json" | "csv" | "image" | "pdf" | "other"
  mime            TEXT,                           -- "text/markdown" 等
  size_bytes      INTEGER,
  sha256          TEXT,                           -- 改ざん検知 / 重複検出
  created_by      TEXT NOT NULL,                  -- "user" | "yui" | "agent" | "external"
  created_by_task BIGINT REFERENCES todos(id) ON DELETE SET NULL,  -- どの task の成果物か
  notes           TEXT,                           -- 「議事録 v1」「KFC 見積もり 試算」等
  archived        BOOLEAN NOT NULL DEFAULT false,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (project_id, path)
);
CREATE INDEX idx_project_files_project ON project_files (project_id, archived);
CREATE INDEX idx_project_files_task ON project_files (created_by_task);
```

**重要設計**:
- `path` は project workspace 内の相対パス (`/workspaces/<slug>/` の中の物)
- ファイル本体は filesystem。DB は metadata 専用
- `created_by_task` で「T-11 の成果物」を逆引き可能 (= task ↔ file の M:N back-link は
  artifact_links を経由するが、主たる「生成元 task」はここに 1 個固定で持つ方が運用楽)
- `archived=true` でソフトデリート (= ファイル本体は残す、UI 非表示)

### 3.2 `work_logs` (Phase 2)

```sql
CREATE TABLE work_logs (
  id          BIGSERIAL PRIMARY KEY,
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     BIGINT REFERENCES todos(id) ON DELETE SET NULL,  -- 任意 (= project 横断ログもあり)
  actor       TEXT NOT NULL,                  -- "user" | "yui" | "agent_<id>" | "system"
  kind        TEXT NOT NULL,                  -- "action" | "note" | "question" | "answer" | "milestone" | "result" | "error"
  content     TEXT NOT NULL,                  -- 自由テキスト
  metadata    JSONB,                          -- 構造化 (tool 名、検索クエリ、生成 file ids 等)
  artifact_links JSONB,                       -- 関連リソースへの polymorphic 参照
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_work_logs_project_created ON work_logs (project_id, created_at DESC);
CREATE INDEX idx_work_logs_task ON work_logs (task_id, created_at DESC);
CREATE INDEX idx_work_logs_actor ON work_logs (actor);
```

**kind の使い分け**:
- `action`: tool 呼出 / file 作成等の具体アクション (= Yui や agent が自動で書く)
- `note`: 人が手書きしたメモ
- `question`: agent からの質問 (= ご主人様への問い合わせ)
- `answer`: ご主人様からの回答 (= question への返答、紐付け用 reply_to を metadata に持つ)
- `milestone`: 大きな区切り ("T-11 着手" "v1 完成")
- `result`: 最終成果物への参照
- `error`: 実行中の失敗 (= 後で再開できるよう詳細を残す)

### 3.3 `agent_runs` (Phase 3)

タスク実行エージェントの 1 ラン (= 1 つの T-N に対する 1 回の実行) を管理:

```sql
CREATE TABLE agent_runs (
  id          BIGSERIAL PRIMARY KEY,
  task_id     BIGINT NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  project_id  BIGINT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  agent_type  TEXT NOT NULL,                  -- "task_executor" | "doc_writer" | "researcher" 等
  status      TEXT NOT NULL,                  -- "running" | "waiting_input" | "completed" | "failed" | "cancelled"
  current_step TEXT,                          -- "collecting_context" | "asking" | "executing" | "writing_result"
  pending_question TEXT,                      -- waiting_input 状態の時、未回答の質問本文
  result_summary TEXT,                        -- 完了時のサマリ
  model_used  TEXT,
  tokens_in   INTEGER, tokens_out INTEGER,
  cost_usd    REAL,
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ,
  metadata    JSONB                           -- step 履歴 / 中間状態
);
CREATE INDEX idx_agent_runs_status ON agent_runs (status, started_at DESC);
CREATE INDEX idx_agent_runs_task ON agent_runs (task_id, started_at DESC);
```

- 1 task に対して複数 run も可能 (= 失敗 → 再実行 / question 待ち中断 → 再開)
- `status="waiting_input"` で停止中 → user が回答すると agent_runs を `running` に戻して continue
- 中断耐性のため `metadata` に step 履歴 / プロンプト履歴を JSON で永続化

---

## 4. Filesystem レイアウト

### 4.1 Docker volume

```yaml
# docker-compose.yml に追加
services:
  web:
    volumes:
      - ./workspaces:/workspaces  # host bind mount (= 外部ツールからも見える)
      # or
      - workspaces_data:/workspaces  # named volume (= portability)
```

実環境では **host bind mount 推奨** (= claude code 等の外部ツール、coding shell §8 から
直接編集可能になる)。本番デプロイなら named volume も可。

### 4.2 ディレクトリ構造

```
/workspaces/
  ├─ <project-slug>/                # projects.slug がそのまま dir name
  │   ├─ 見積書/
  │   │   ├─ T-11_KFC_v1.md
  │   │   └─ T-11_KFC_v2.md
  │   ├─ 議事録/
  │   │   └─ 2026-06-03_山口さん打合せ.md
  │   ├─ 資料/
  │   │   ├─ security-spec.pdf
  │   │   └─ requirements.csv
  │   ├─ 調査メモ/
  │   │   └─ 競合分析.md
  │   └─ .yui/                     # Yui 内部用 (隠し)
  │       ├─ CLAUDE.md             # project context (8.2c で言及)
  │       └─ agent_state/          # agent_runs の中間ファイル
  ├─ <project-slug-2>/
  └─ _orphan/                       # project 削除済みのファイル一時退避
```

- **slug** は project 作成時に自動生成 (= 日本語 project 名は roman 化 or hash)
- 隠しディレクトリ `.yui/` に project の Yui 用 meta を置く
- 削除された project のファイルは即消さず `_orphan/<original_slug>/` に移動 (= 復旧可能)

### 4.3 path 正規化

- 親ディレクトリ参照 (`..`) は **絶対禁止** (path traversal 対策)
- `path` カラムは常に `<dir>/<file>` 形式 (先頭スラッシュ無し、project workspace 内相対)
- 拡張子から `kind` / `mime` を自動推定 (md → markdown、json → json、png/jpg → image、etc.)

---

## 5. API 設計

### 5.1 Project Files (Phase 1)

| Method | Path | 用途 |
|---|---|---|
| GET    | `/api/projects/[id]/files`                 | tree 構造で list |
| POST   | `/api/projects/[id]/files`                 | 新規作成 (body または upload) |
| GET    | `/api/projects/[id]/files/[fileId]`        | metadata 取得 |
| GET    | `/api/projects/[id]/files/[fileId]/content`| 本文取得 (text/binary 切替) |
| PATCH  | `/api/projects/[id]/files/[fileId]`        | metadata 更新 (path rename / notes) |
| PUT    | `/api/projects/[id]/files/[fileId]/content`| 本文上書き |
| DELETE | `/api/projects/[id]/files/[fileId]`        | archived=true (soft) |
| DELETE | `/api/projects/[id]/files/[fileId]?hard=1` | 完全削除 (= filesystem からも消す) |

**サイズ制限**:
- text 系: 10 MB / file
- binary: 50 MB / file
- total per project: 1 GB warn、5 GB hard limit

**versioning** (Phase 1.5、任意):
- PUT 時に `_versions/<fileId>/<timestamp>.md` に旧版を退避
- 直近 10 版のみ保持

### 5.2 Work Logs (Phase 2)

| Method | Path | 用途 |
|---|---|---|
| GET    | `/api/projects/[id]/work-logs?taskId=&actor=&kind=&limit=` | timeline 取得 |
| POST   | `/api/projects/[id]/work-logs`                              | 手動 note 追加 |
| DELETE | `/api/projects/[id]/work-logs/[logId]`                      | 削除 (= user note 用、agent 系は基本残す) |

### 5.3 Agent Runs (Phase 3)

| Method | Path | 用途 |
|---|---|---|
| POST   | `/api/todos/[taskId]/dispatch-agent`              | エージェント起動 (新規 run 作成) |
| GET    | `/api/agent-runs/[runId]`                         | 状態取得 (= UI polling 用、SSE もあり) |
| POST   | `/api/agent-runs/[runId]/answer`                  | waiting_input への回答送信 |
| POST   | `/api/agent-runs/[runId]/cancel`                  | 中断 |
| GET    | `/api/agent-runs?status=&limit=`                  | 一覧 (= 「進行中の仕事」UI) |

---

## 6. Yui tools

### 6.1 ファイル操作 (Phase 1)

```ts
create_project_file(project_id, path, content, kind?, notes?)
read_project_file(project_id, path | fileId)
list_project_files(project_id, dir_prefix?)
update_project_file(project_id, fileId, content?, path?, notes?)
delete_project_file(project_id, fileId, hard?)
```

**Yui prompt 追記**:
- 「ファイル作って」「下書き保存して」「議事録残して」等で呼ぶ
- path は人間が読める日本語 OK (例: "見積書/T-11_KFC_v1.md")
- 大きい binary は扱わない (= 別途アップロード経路)

### 6.2 作業ログ (Phase 2)

```ts
write_work_log(project_id, task_id?, kind, content, metadata?, artifact_links?)
list_work_logs(project_id, task_id?, limit?)
```

Yui は **tool 呼出時に自動で work_log を書く** (= 全 file 操作 / web_search / todo
更新 等の主要 action は背後でログ化)。手書きは note 用。

### 6.3 エージェント起動 (Phase 3)

```ts
dispatch_task_executor(task_id, prompt_override?, context_hint?)
//   → agent_runs に新規 row 作成、background job kick
//   → 結果は SSE 経由で Yui voice 報告
get_agent_run(run_id)
list_agent_runs(status?)
```

Yui への指示: 「T-11 を任せられそうな複雑度の場合のみ提案、即実行は user 確認後」。

---

## 7. Task Execution Agent の動作仕様

### 7.1 ライフサイクル

```
[dispatch] → status="running", step="collecting_context"
  ↓
1. context 集計:
   - todos: 該当 task + project 内の関連 task (= project_links)
   - project_files: workspace 内既存ファイル一覧 + .yui/CLAUDE.md
   - work_logs: 該当 task の過去ログ
   - memory_chunks: project キーワードで semantic 検索
   - calendar / mail / diary の project_links
  ↓
2. ステップ計画 (Sonnet/Opus 1 call):
   - 何を作る? どんな情報が要る?
   - 手元の context で十分か?
  ↓
3a. 情報不足 → status="waiting_input", step="asking"
    work_logs に kind="question" で記録 → Yui voice で質問
    [user 回答待ち]
    ご主人様回答 → POST /api/agent-runs/[id]/answer
    work_logs に kind="answer" で記録 → status="running" に戻して continue
  ↓
3b. 情報十分 → status="running", step="executing"
    具体作業:
    - web_search / web_fetch
    - create_project_file / update_project_file
    - 関連 todo の create / update
    - write_work_log (kind="action" を都度書く、透明性)
  ↓
4. step="writing_result"
    成果物 metadata まとめ + 最終 report 作成 → result_summary
  ↓
5. status="completed"
    work_logs に kind="result" で記録 + artifact_links
    関連 todo を state="done" or "in_progress" 更新
    Yui voice で報告 + ReportPanel に長文 markdown
```

### 7.2 質問ループ (= waiting_input の振る舞い)

エージェントは **不確実性を恐れず質問する** 設計:
- 「予算範囲は?」「先方の連絡先は?」「過去の類似見積りはありますか?」
- 1 question = 1 work_log row (kind="question") + 1 Yui voice
- 複数質問が出る時は 1 ターンで全部出す (= ご主人様往復回数を減らす)
- ご主人様が回答 → answer 経由で resume

中断耐性: agent_runs.metadata に「現在の step / 中間結果 / 次の予定」を都度永続化。
process 再起動でも続きから再開できる。

### 7.3 モデル選択

| 機 | Phase 3 (Sonnet 版) | Phase 4 (Agent SDK 版) |
|---|---|---|
| 計画 | Sonnet 4.6 | Opus (Agent SDK) |
| web 多段探索 | 単純な web_search/fetch 1-2 hop | Opus + 10-30 step |
| 文章作成 | Sonnet | Opus |
| cost | API 直接 (Sonnet $3/$15) | サブスク枠 (Pro/Max) |
| いつ | 6/15 前から | 6/15 以降本格 |

Phase 3 → Phase 4 は LLM ルーターの role 追加で済む構造にする。

### 7.4 並列 / 直列

- 同 project / 同 task で **同時 1 run まで** (UNIQUE 制約は付けないが API レベルで拒否)
- 別 project / 別 task は並列 OK
- 全体で max 3 並列 (= API rate limit / 注意散漫防止)

---

## 8. UI/UX

### 8.1 Project Hub Modal を拡張

```
┌─ Project: KFC 連携 ──────────────────────────────────────┐
│ [概要] [Todos (9)] [予定] [メール] [日記] [ファイル ★] [作業ログ ★] │
│                                                          │
│  === ファイル tab (新) ===                                │
│  ┌─ Tree ────────┐ ┌─ Preview ────────────────────────┐ │
│  │ 📁 見積書       │ │ # T-11 KFC 見積もり v2            │ │
│  │   📄 T-11_v1.md │ │                                  │ │
│  │   📄 T-11_v2.md │ │ ## 概要                          │ │
│  │ 📁 議事録       │ │                                  │ │
│  │ 📁 資料         │ │ KFC への ...                     │ │
│  │ 📁 調査メモ     │ │                                  │ │
│  │                 │ │ [編集] [履歴] [削除]              │ │
│  │ + 新規ファイル  │ │ 🤖 T-11 のエージェント生成 ✓     │ │
│  └────────────────┘ └──────────────────────────────────┘ │
│                                                          │
│  === 作業ログ tab (新) ===                                │
│  2026-06-03 15:42 🤖 [agent] T-11 着手                   │
│  2026-06-03 15:43 ❓ [agent → user] 予算範囲は?          │
│  2026-06-03 15:50 💬 [user → agent] 500-800 万でお願い   │
│  2026-06-03 15:55 🌐 [agent] web search "...セキュリティ..." │
│  2026-06-03 16:05 📄 [agent] 見積書/T-11_v1.md 作成      │
│  2026-06-03 16:12 ✅ [agent] T-11 完了、todo update      │
│  2026-06-03 17:00 📝 [user] note: クライアントに送信済   │
└──────────────────────────────────────────────────────────┘
```

### 8.2 「Yui に任せる」ボタン

- TodoModal の各 row hover で右側に出現 (kebab menu 内でも可)
- クリックで confirm popup: 「T-11 を Yui に任せます。プロジェクト情報を集めて実行します。」
- 押すと dispatch → todo の state は `in_progress_by_agent` 系の表示 (新 state 不要、既存 in_progress に flag `agent_run_id` を持つ)

### 8.3 Agent run 進捗カード (ReportPanel)

```
┌─ 🤖 T-11 進行中 ────────────────────────────┐
│ Project: KFC 連携                            │
│ Status: 実行中 (web 調査 → 文書作成)         │
│ Step: writing_result                         │
│                                              │
│ 直近: 「見積書/T-11_v1.md を作成」(2 分前)   │
│                                              │
│ [詳細を見る] [中断]                          │
└──────────────────────────────────────────────┘
```

- waiting_input 状態の時は赤系で目立たせる + 「回答する」ボタン
- 完了で badge + 成果物リンク → ファイル tab にジャンプ

### 8.4 ChatPanel での扱い

エージェントからの質問は **Yui の声で読み上げ**:
- 「ご主人様、T-11 の見積もりを進めているのですが、予算範囲はどのくらいでしょうか?」
- ご主人様の自然な返答を agent run の answer として自動連結
- これは Phase 3 で実装、ChatPanel 側で agent_runs の waiting_input をリッスン

---

## 9. セキュリティ / 安全策

### 9.1 path traversal 対策
- API 受付時に `path` を正規化 (`path.normalize` → `..` 除外)
- 絶対パス禁止、project workspace root を超える解決は 400

### 9.2 ファイルサイズ / 数
- 1 file 50MB hard limit、project 全体 5GB
- 1 project 内 file 数 1,000 上限

### 9.3 Agent の暴走防止
- 1 run の API call 上限: 100 (= Sonnet で 100 ターン)
- 1 run の cost 上限: $5
- 上限超過で自動 cancel + error log
- 「破壊的操作」(delete_project_file with hard=1、todo の done →backlog 戻し、等) は agent では出来ない設計 (= soft delete のみ許可)

### 9.4 プライバシー
- workspace は **ホスト bind mount** を選んだ場合、ホストの fs にも見える
- 機密プロジェクトは別途 暗号化 (将来)
- agent_runs の prompt 履歴に raw_messages 全文は入れない (= 要約 + 必要箇所のみ)

### 9.5 中断耐性
- agent_runs.metadata に毎 step 状態を保存
- process 再起動 / クラッシュ後も `status="running"` で再開可能 (= idempotent な step 設計)

---

## 10. 既存資産との関係

| 既存 | 関係 |
|---|---|
| `projects` | そのまま。`slug` 列を活用 (workspace dir 名) |
| `todos` | task source。`agent_run_id` を flag で持つ |
| `project_links` (M:N) | files / work_logs にも適用拡張可能 |
| `memory_chunks` | agent context 集計の source。work_logs とは別 |
| `mail_messages` / `diary_entries` / `calendar_events` | project_links で紐付けて context 集計に使う |
| `artifact_links` | files の back-link としても利用 |
| roadmap §8 (Shell + Yui Coding Mode) | `<project>/.yui/CLAUDE.md` を共有。コード作業時の context も同じ workspace を使う |
| roadmap §4 (Doc Agent) | task_executor の特化版として位置付け。Doc Agent は output が doc 限定、task_executor は何でも |
| roadmap §5 (Deep Research Agent) | task_executor が web 調査 sub-task で deep-research をネスト dispatch する可能性あり (Phase 4 で検討) |

---

## 11. cost 概算

### 11.1 Phase 3 (Sonnet 版)

1 task 実行 (中規模、見積書 1 通):
- context 集計: 5K tokens × Sonnet $3/M = $0.015
- 計画 (1 call): 2K in + 1K out × Sonnet = $0.021
- 質問ループ (avg 2 往復): 各 3K in + 0.5K out × Sonnet × 2 = $0.033
- 実行 (web 検索 1-2、ファイル作成 1-2): 10K in + 5K out × Sonnet × 2 = $0.21
- 報告 (Haiku): 3K in + 1K out × Haiku $1/$5 = $0.008

**1 task ≈ $0.30**。1 日 5 task で月 ~$45。許容範囲。

### 11.2 Phase 4 (Agent SDK / Opus)

同じ 1 task が Opus で:
- 全体で 30-50K tokens × Opus = ~$1.5-3.0
- ただし **サブスク枠** (Pro $20/月、Max5x $100/月) に含まれる → 実質追加無料

→ **6/15 以降は Opus 一択** が経済合理性に合う。

### 11.3 ストレージ

- ファイル: 1 project 平均 100MB 想定 × 50 project = 5GB → SSD で十分
- DB: project_files + work_logs + agent_runs で年間 ~500MB 程度

---

## 12. 実装フェーズ

### Phase 1 — Project Workspace (= ファイル機能)
**所要 1〜2 日、6/15 を待たずに着手可**

- `0051_project_files.sql` migration
- filesystem layout (Docker volume + path 正規化 helper)
- `lib/project-files.ts` (CRUD + path 正規化 + sha256)
- API endpoints (§5.1)
- Yui tools 5 種 (create / read / list / update / delete) + prompt 追加
- Project Hub Modal に「ファイル」tab + tree + preview (markdown render + text + image)
- Yui の chat 内で「下書き作って」「議事録残して」で動作するか検証

### Phase 2 — Work Log
**所要 1 日、Phase 1 完了後**

- `0052_work_logs.sql`
- `lib/work-logs.ts` (CRUD)
- API + Yui tools
- Project Hub に「作業ログ」tab + timeline 表示
- Yui の全 tool 呼出を自動ログ化 (= `chat/route.ts` の tool dispatch loop に挿入)
- 「note 追加」ボタン (手書きメモ)

### Phase 3 — Task Execution Agent (Sonnet 版)
**所要 3〜5 日、6/15 前のプロトタイプ**

- `0053_agent_runs.sql`
- `lib/agents/task-executor.ts` (= 7.1 のステートマシン)
- background job dispatcher 拡張 (既存 specialists 経路の流用検討)
- `lib/agents/context-collector.ts` (= 7.1 step 1 の context 集計)
- `lib/agents/question-loop.ts` (= waiting_input 状態管理)
- API endpoints (§5.3) + SSE で進捗 push
- TodoModal に「🤖 任せる」ボタン
- ReportPanel に agent run 進捗カード
- ChatPanel で waiting_input → Yui voice → answer 取り込み

### Phase 4 — Agent SDK / Opus 切替
**所要 1〜2 日、6/15 以降**

- LLM router に Agent SDK 経路追加
- `task_executor` role を Opus へ切替
- multi-step / deep tool use の検証
- Doc Agent (roadmap §4) を `task_executor` の specialization として実装
- Deep Research Agent も同様

### Phase 5 (任意) — versioning + 高度 UI
- ファイル versioning (`_versions/<fileId>/`)
- diff view (markdown diff)
- 「過去の Yui の作業」検索 (work_logs を全文検索 / embedding 検索)
- agent run の transcript 再生 (= タイムマシン)

---

## 13. 検証シナリオ (Phase 3 完了時点)

ご主人様: 「T-11 (KFC 見積書作成) を任せる」

Yui (dispatch_task_executor 呼出):
> ご主人様、T-11 着手します。少々お時間いただけますか。

[agent_run started, status=running]
- context 集計: KFC project の todos 9 件 + project_files (なし) + work_logs (なし) +
  memory_chunks "KFC" 検索 + 関連 mail 3 件 (山口さんとのスレッド)
- 計画: 「見積書 markdown を作る。予算範囲 / 標準工数 / 導入時期 を確認したい」

[status=waiting_input]
Yui:
> KFC の見積もりを進めているのですが、3 点お聞きしてもよろしいですか?
> 1. 予算範囲 (上限の目安)
> 2. 標準的な工数単価
> 3. 10 月導入を盛り込むかどうか

ご主人様: 「予算 500-800、単価は通常レート、10 月導入は希望ベースで」

[status=running]
- web_search "KFC セキュリティ要件" → 公開情報のヒント取得
- create_project_file "見積書/T-11_KFC_v1.md" (本文約 800 字)
- create_project_file "見積書/T-11_KFC_v1_breakdown.csv" (内訳)
- update_todo T-11 → state="done"
- write_work_log kind="milestone" "T-11 完了"

[status=completed]
Yui:
> ご主人様、T-11 終わりました。見積書 v1 と内訳 CSV をファイルに置きましたので
> お時間ある時にご確認ください。山口さんへの送信文面もたたき台で作りましょうか?

→ ReportPanel に成果物リンクとサマリ markdown。

---

## 14. 関連設計書

- `docs/roadmap.md` §4 (Doc Agent) — Phase 4 で統合
- `docs/roadmap.md` §5 (Deep Research Agent) — 同上
- `docs/roadmap.md` §8 (Shell + Yui Coding Mode) — workspace dir を共有、CLAUDE.md 共有
- `docs/memory-architecture.md` — context 集計の source
- `docs/notification-system.md` — agent からの質問 / 完了報告経路 (将来統合可能)
- `docs/health-tracking.md` — エージェントとは独立、参考実装として「post-turn 自律処理」の感覚
