# 長期記憶 / Orchestration アーキテクチャ設計書

このプロジェクトの長期記憶 (long-term memory) と将来のエージェント orchestration の統合設計をまとめたもの。

スコープは段階的に拡大する:

- **Phase 1〜3**: 記憶層の構築 (現在着手中)
- **Phase B**: MCP統合 (Plane, Calendar, Gmail等)
- **Phase C**: バックグラウンドタスク実行
- **Phase D**: サブエージェント orchestration (Yuiの部下たち)
- **Phase F**: Discord text bot — Yui を Discord 上で起動・対話できる
- **Phase G**: Proactive autonomy — 定期チェックして必要なら自律発話
- **Phase H**: Discord voice — voice channel で音声対話

Phase 1 を実装するときに後のフェーズで必要になる schema/構造を入れておくことで、後の migration コストを最小化する。

**前提**: 本システムは **完全に個人用シングルユーザー**。マルチユーザー対応は永久にやらない。これにより認証/権限/隔離の複雑性を全部削減できる。

## 1. ゴール / ノンゴール

### ゴール

- **セッションを跨いでユーザー像と過去のやりとりを覚えている** — Yuiが「先週コーヒー豆を変えた話」「魚アレルギーがあること」を自然に踏まえて応答する
- **応答レイテンシを増やしすぎない** — ベースライン (~700ms before TTS) に対して+300ms以内
- **個人用シングルユーザーで運用可能なコスト** — 月 ~$10 以下を目標
- **将来の Orchestration 層と無理なく接続できる** — サブエージェントが記憶を読み書きする、外部システム (Plane等) の情報を文脈として持つ、非同期タスク結果を会話に自然に折り込む、これらが Phase 1 の schema 設計に矛盾しない
- **外部システム (Plane / Gmail / GCal等) を Single Source of Truth として尊重する** — ローカルにフルミラーは作らない、参照と文脈オーバーレイのみ

### ノンゴール (永久に or 当面追わない)

- **マルチユーザー対応** (永久) — 完全個人用システム。`user_id` カラム等の用意もしない
- 完全な temporal reasoning ("X年Y月の時点での状態を再現") — 当面追わない
- 知識グラフ構築 (Zep/Graphiti級) — Phase E以降の検討事項
- 外部システムへの双方向同期 (Yui側で Plane / GCal を canonical にしない)
- セッションのマルチデバイス同期 — 現状は実質1端末/1ユーザーなので保留

## 2. アーキテクチャ概要

### 2.1 7層コンテキスト構造

毎ターンの推論コンテキストは以下7層から組み立てる。L4.5 は Phase C 以降だが schema 上は Phase 1 から予約しておく:

| 層 | 場所 | スコープ | サイズ目安 | 更新頻度 | Phase |
|---|---|---|---|---|---|
| **L1 人格** | system prompt (cached) | 不変 | ~2K tok | プロンプト編集時のみ | 1 |
| **L2 常時facts** | system prompt | 全期間、重要度高いN件 | ~500 tok | セッション末/明示更新 | 1 |
| **L3 直近セッション要約** | system prompt | 直近 3 セッション | ~600 tok | セッション末 | 2 |
| **L4 semantic retrieval** | system prompt | 過去全体 (現セッションも含む) | ~1500 tok | 毎ターン動的 | 1 |
| **L4.5 pending task results** | system prompt | 完了済み未通知のYui内部タスク | ~500 tok | 毎ターン動的 | C |
| **L5 直近verbatim** | messages[] | 現セッション末尾 | 直近 N=8 turn | 毎ターン | 0 (現状) |
| **L6 今のuser発話** | messages[] (末) | 今 | 1 turn | 今 | 0 (現状) |

### 2.2 全体システム図 (Phase H までの将来像)

```
┌─ Web UI ──┐  ┌─ Discord text ┐  ┌─ Discord voice ┐  ┌─ Cron (proactive) ┐
│  (現状)    │  │  (Phase F)     │  │  (Phase H)      │  │  (Phase G)         │
│  Next.js   │  │  discord.js    │  │  @discordjs/    │  │  node-cron /       │
│  + VRM     │  │  bot (DM)      │  │  voice + STT   │  │  Vercel Cron       │
└────┬───────┘  └─────┬──────────┘  └─────┬───────────┘  └─────┬──────────────┘
     │ HTTP POST      │ HTTP POST         │ HTTP POST          │ scheduled trigger
     │                │                   │                    │
     └────────────────┴───────────────────┴────────────────────┘
                                │
                                ▼
                  ┌───────────────────────────────────────────────────────────┐
                  │ /api/chat — Yui Agent Core (Next.js Route Handler)        │
                  │  ┌──────────────────────────────────────────────────────┐ │
                  │  │ 1. retrieve L2/L3/L4/L4.5 ──► system prompt 組み立て  │ │
                  │  │ 2. Claude (Haiku) 応答                                  │ │
                  │  │ 3. 応答返却 + TTS (リクエスト元の interface に応じる)   │ │
                  │  │ 4. 必要なら background task をkick → tasks にinsert    │ │
                  │  │ 5. raw_messages にinsert (source カラムで interface 記録)│ │
                  │  └──────────────────────────────────────────────────────┘ │
                  └──────────┬────────────────────────┬───────────────────────┘
                             │ READ                   │ READ/WRITE
                             ▼                        ▼
                     ┌─────────────────────┐   ┌──────────────────────────┐
                     │  外部システム         │   │  Local Postgres+pgvector  │
                     │  (Plane / GCal /     │   │  ┌────────────────────┐  │
                     │   Gmail / ...)       │◄─►│  │ raw_messages       │  │
                     │  via MCP/REST/       │   │  │ memory_chunks      │  │
                     │   webhook            │   │  │ tasks              │  │
                     │                      │   │  │ (将来: agent_runs) │  │
                     │  - SoT として尊重    │   │  └────────────────────┘  │
                     │  - フルミラーしない   │   └──────────────────────────┘
                     │  - memory_chunks に   │              ▲
                     │    source_id 経由で  │              │ READ/WRITE
                     │    薄く連携          │              │
                     └─────────────────────┘              │
                                                          │
   ┌──────────────────────────────────────────────────────┴────────────┐
   │  Phase D: サブエージェント orchestration                              │
   │  (Anthropic Managed Agents or LangGraph)                              │
   │  ┌──────────────────────────────────────────────────────────────┐    │
   │  │ research_agent / email_agent / scheduling_agent              │    │
   │  │ - memory_chunks への READ 権限                                  │    │
   │  │ - 完了時に tasks.output 更新 + memory_chunks に task_result投入│    │
   │  │ - pending_acknowledgement = TRUE で次ターン Yui が切り出す      │    │
   │  └──────────────────────────────────────────────────────────────┘    │
   └───────────────────────────────────────────────────────────────────────┘
```

**ポイント**:
- すべての interface (Web/Discord text/Discord voice/Cron) は同じ `/api/chat` を入口とし、core は変わらない
- 入力 source は `raw_messages.source` カラムで記録
- 出力先は request の destination 情報に従って adapter が分配 (web SSE / Discord message / Discord voice / 通知push)
- Cron は **入力なし** に発火する唯一の経路 — 状態差分を計算して必要なら会話の "種" を投入

### 2.3 データフロー (毎ターン、Phase 1 視点)

```
user input
   │
   ├─► [embed query] (last 1-2 user turns + current)
   │      │
   │      ▼
   ├─► [hybrid search] semantic + BM25 + time decay
   │   WHERE chunk_type IN (...) AND invalidated_at IS NULL
   │   (現セッションも含める。下記§4.2注記参照)
   │      │
   │      ▼
   ├─► [MMR dedup] top-K=5  →  L4
   │
   ├─► [load L2/L3] (DBクエリ、軽い)
   │
   ├─► [check L4.5] SELECT FROM tasks WHERE pending_acknowledgement
   │   (Phase 1ではテーブル空、no-op)
   │
   └─► [prompt build]
          L1 (persona, cached)
          + L2 (facts, top-N by importance)
          + L3 (recent 3 session summaries)
          + L4 (top-K retrieved)
          + L4.5 (pending task results, あれば)
          → system
          + L5 (last 8 turns) + L6 (current) → messages[]
   │
   ▼
Claude (Haiku 4.5) → reply
   │
   ├─► return to client / TTS
   │
   └─► background:
        - raw_messages に turn pair を insert
        - 8 turn 溜まったら rolling extraction (Phase 2)
        - session end (10分無操作) で session summary 生成
        - Phase C以降: 必要ならtask kick (researchとか)
```

### 2.4 ストレージ層

PostgreSQL + pgvector を Docker サービスとして追加 (`ankane/pgvector`)。

3テーブル (Phase 1 で全部作成。`tasks` は空でいい):

- `raw_messages` — 全ターン素のまま (監査・再抽出用、検索対象外)
- `memory_chunks` — 抽出済みメモリ項目 (検索対象、ベクトル付き、外部参照も可能)
- `tasks` — Yui内部タスクの状態 (Phase Cで本格活用、Phase 1ではschemaのみ)

## 3. データベーススキーマ

### 3.1 raw_messages

```sql
CREATE TABLE raw_messages (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT NOT NULL,
  role         TEXT NOT NULL CHECK (role IN ('user','assistant')),
  content      TEXT NOT NULL,
  emotion      TEXT,           -- assistantの応答時のみ (happy/sad/...等)
  
  -- どのインターフェース由来か (Phase F以降で活用、Phase 1ではすべて 'web')
  source       TEXT NOT NULL DEFAULT 'web',
                 -- 'web' | 'discord_text' | 'discord_voice' | 'cron'
  
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX ON raw_messages (session_id, created_at);
CREATE INDEX ON raw_messages (source, created_at DESC);
```

検索対象ではない。あくまで:
- 監査ログ (何を話したかの完全な記録)
- 抽出ロジックの再実行 (プロンプト改善時のリプレイ)
- セッション要約の元データ
- どのインターフェースを多く使っているかの分析用 (source カラム)

### 3.2 memory_chunks

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_chunks (
  id             BIGSERIAL PRIMARY KEY,
  session_id     TEXT,                    -- 抽出元のセッション (subagent書き込み等で NULL あり)
  chunk_type     TEXT NOT NULL,           -- §3.3 の語彙
  content        TEXT NOT NULL,           -- 1〜3文の自然言語ステートメント
  embedding      vector(1024),            -- bge-m3 1024次元
  importance     REAL NOT NULL DEFAULT 0.5,  -- 0..1
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  
  -- 誰が書き込んだか (Phase D で重要に)
  actor_type     TEXT NOT NULL DEFAULT 'extraction',
                 -- 'extraction' | 'subagent' | 'mcp_sync' | 'user_direct' | 'system'
  actor_id       TEXT,                    -- 'main_chat' | 'research_agent' | 'gcal_mcp' | NULL等
  
  -- 外部システム参照 (Phase B で活用、Phase 1ではNULL)
  source_system  TEXT,                    -- 'plane' | 'gcal' | 'gmail' | NULL (内発的記憶)
  source_id      TEXT,                    -- 外部システムのID (issue_xyz / event_id 等)
  
  -- 将来のGraphiti移行用に bi-temporal カラムを予約 (現フェーズでは未使用)
  valid_from     TIMESTAMPTZ DEFAULT NOW(),
  valid_to       TIMESTAMPTZ,             -- NULL = current
  invalidated_at TIMESTAMPTZ,             -- "この事実が間違いと判明した日時"
  
  metadata       JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX ON memory_chunks USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
CREATE INDEX ON memory_chunks (chunk_type, importance DESC);
CREATE INDEX ON memory_chunks (created_at DESC);
CREATE INDEX ON memory_chunks (source_system, source_id) WHERE source_system IS NOT NULL;
CREATE INDEX ON memory_chunks (actor_type, actor_id);
CREATE INDEX ON memory_chunks USING gin (to_tsvector('simple', content));
```

### 3.3 chunk_type の使い分け (拡張版)

カテゴリ別に整理:

**記憶系 (人物理解)**

| chunk_type | 内容 | 例 | Phase |
|---|---|---|---|
| `fact` | 不変/長期事実 | "ユーザーは魚アレルギー" | 1 |
| `preference` | 好み (変わる可能性) | "和食を好む、特に煮物" | 1 |
| `event` | 出来事 (日時付き) | "5/20、プレゼンを終えて疲れていた" | 1 |
| `emotion` | 感情パターン | "コーヒー話題で機嫌が良くなる" | 1 |
| `summary` | セッション要約 | "5/22はコーヒー豆の話で盛り上がった" | 2 |
| `turn_summary` | ローリング抽出 (8turn毎) | (現セッション内の中間要約) | 2 |
| `procedural` | 手順記憶/ルーチン | "ユーザーは朝のメールチェックを毎日望む" | B |

**Orchestration系 (タスク/外部統合)**

| chunk_type | 内容 | 例 | Phase |
|---|---|---|---|
| `commitment` | Yuiの約束 | "土曜までにレストラン候補を調べると約束した" | C |
| `task_result` | サブエージェントの結果サマリ | "research_agent: 土曜の3軒見つけた→ tasks#42" | D |
| `external_ref` | 外部システム情報の文脈オーバーレイ | "PROJ-123は年次レビューで毎年プレッシャー" | B |

`chunk_type` は TEXT カラムなので拡張は値の追加だけ (schema 変更不要)。**この語彙表が canonical**。バラバラに使われないよう必ずここを参照する。

### 3.4 tasks (Phase 1 でschemaだけ作る、Phase Cから本格利用)

**重要**: このテーブルは **Yui内部のorchestration stateのみ**を保持する。ユーザー向けTODOは Plane (オンプレ) が canonical で、ここには保存しない。混ぜると Plane が Yui ノイズで汚れる。

```sql
CREATE TABLE tasks (
  id           BIGSERIAL PRIMARY KEY,
  session_id   TEXT,                       -- 発生元のチャットセッション (NULLable: cron等から発生)
  initiated_by TEXT NOT NULL,               -- 'yui' | 'user' | 'cron' | 'webhook'
  agent_name   TEXT NOT NULL,               -- 'research_agent' | 'email_agent' | 'inline' 等
  task_type    TEXT NOT NULL,               -- 'research' | 'draft_email' | 'sync_calendar' 等
  status       TEXT NOT NULL DEFAULT 'pending',
                 -- 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'
  input        JSONB NOT NULL,              -- リクエスト内容 (e.g., "土曜 イタリアン 4人")
  output       JSONB,                       -- 結果
  error        TEXT,
  
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  deadline     TIMESTAMPTZ,                 -- "これまでに終えてほしい" 期限 (任意)
  
  -- 「Yuiが次のチャットで触れるべきか」フラグ (L4.5 で読まれる)
  pending_acknowledgement BOOLEAN NOT NULL DEFAULT FALSE,
  acknowledged_at         TIMESTAMPTZ,
  
  -- タスク完了時に memory_chunks に summary を投入したら、その chunk_id を記録
  resulting_chunk_id BIGINT REFERENCES memory_chunks(id) ON DELETE SET NULL,
  
  -- 外部システムにエコーした場合 (Plane に issue 作った等)
  external_ref_system  TEXT,
  external_ref_id      TEXT,
  
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX ON tasks (status, created_at DESC);
CREATE INDEX ON tasks (pending_acknowledgement) WHERE pending_acknowledgement;
CREATE INDEX ON tasks (agent_name, status);
CREATE INDEX ON tasks (session_id, created_at);
```

**典型的なライフサイクル例 (Phase D)**:

```
1. ユーザー: 「土曜の夜、イタリアン4人で探してくれる?」
2. Yui (main chat): tool use → tasks にINSERT
   { initiated_by:'yui', agent_name:'research_agent',
     task_type:'research', status:'pending',
     input:{topic:'restaurant', cuisine:'italian',
            datetime:'Saturday 19:00', people:4} }
3. Managed Agents session が research_agent を起動 → status='running'
4. 検索完了 → tasks.output に結果、status='succeeded',
   pending_acknowledgement=TRUE
5. 次のチャットターン: L4.5 で読まれる
6. Yui が自然に切り出して提示 → pending_acknowledgement=FALSE
7. 同時に memory_chunks にtask_result chunkをinsert,
   resulting_chunk_id にFKを書く
```

### 3.5 矛盾解決方針 (Mem0 v3パターン)

**UPDATE/DELETEはしない。蓄積のみ。**

例: 「ユーザーは犬を飼っている」が時間経過後に「ユーザーは猫を飼っている」に変わったとする。両方残す。検索時に created_at 降順で「最新の主張優先」。

利点:
- LLM呼び出しが減る (Mem0 v2の判定ステップを省略)
- 履歴の追跡が可能 (将来 valid_to/invalidated_at を埋めればGraphiti風に変換可)
- 矛盾検出ロジックの複雑性を避けられる

欠点:
- 重複が増える → 月次バッチで cosine sim > 0.95 のみ dedup

## 4. 検索アルゴリズム

### 4.1 クエリ構築

ユーザー発話だけだと参照詞 (「あれ」「さっき」) で空振りするため、直近1〜2 user turn を連結:

```ts
const queryText = [
  ...lastTwoUserTurns,
  currentUserMsg,
].join("\n");
const queryEmbed = await voyageEmbed(queryText, { input_type: "query" });
```

### 4.2 ハイブリッド検索 (semantic + BM25)

⚠️ **設計変更履歴 (2026-05-23)**: 当初は「現セッションを除外」していたが撤回した。
ページリロードでクライアント側 messages[] (L5) は失われるが sessionId は
sessionStorage に残るため、同セッションの過去 raw_messages が rolling 抽出で
memory_chunks に入っていても retrieval から見えず、結果別セッションのデータ
だけが残るという問題が出た。memory_chunks は要約形 ("ユーザーは…" の単独文)
なので L5 (verbatim turn) と意味的に重複しない。よってフィルタを外しても
過剰な重複は発生しない。

Phase 1 ではフィルタは最小限。Phase D 以降で actor / source による絞り込みが可能になる:

```sql
WITH semantic AS (
  SELECT id, 1 - (embedding <=> $1) AS sim
  FROM memory_chunks
  WHERE chunk_type IN ('fact','preference','event','emotion','summary',
                       'turn_summary','procedural','external_ref',
                       'commitment','task_result')
    AND invalidated_at IS NULL
    -- Phase D オプション (現状コメントアウト):
    -- AND ($actor_filter IS NULL OR actor_type = ANY($actor_filter))
    -- AND ($source_filter IS NULL OR source_system = ANY($source_filter))
  ORDER BY embedding <=> $1
  LIMIT 30
),
lexical AS (
  SELECT id, ts_rank(to_tsvector('simple', content), plainto_tsquery('simple', $3)) AS bm25
  FROM memory_chunks
  WHERE to_tsvector('simple', content) @@ plainto_tsquery('simple', $3)
    AND invalidated_at IS NULL
  LIMIT 30
)
SELECT m.id, m.content, m.chunk_type, m.importance, m.created_at,
       m.actor_type, m.source_system, m.source_id,
       COALESCE(s.sim, 0)  AS sim,
       COALESCE(l.bm25, 0) AS bm25
FROM memory_chunks m
LEFT JOIN semantic s ON m.id = s.id
LEFT JOIN lexical  l ON m.id = l.id
WHERE s.id IS NOT NULL OR l.id IS NOT NULL;
```

**Phase D での絞り込み例**:
- 「ユーザー由来の事実だけ思い出して」 → `actor_type IN ('extraction','user_direct')`
- 「Plane タスク関連の文脈だけ」 → `source_system = 'plane'`
- 「research_agent の出力結果は今回は無視」 → `actor_id != 'research_agent'`

### 4.3 スコアリング

JS側で最終スコアを計算:

```ts
function score(chunk: Chunk, now: Date) {
  const ageDays = (now.getTime() - chunk.created_at.getTime()) / 86_400_000;
  const decay = Math.exp(-ageDays / TAU);            // TAU = 30 days
  const semantic = chunk.sim * 0.7;                  // semantic 70%
  const lexical  = chunk.bm25 * 0.3;                 // BM25 30%
  const base = (semantic + lexical) * decay;
  return base * (1 + chunk.importance);              // importance boost
}
```

**パラメータ初期値**:
- `TAU = 30` (1ヶ月で半減)
- semantic 重み 0.7, lexical 重み 0.3
- importance 0..1 を `× (1+importance)` で線形ブースト

### 4.4 MMR (Maximal Marginal Relevance)

top-30 を取った後、JS で類似コンテンツを間引いて top-K=5 に絞る:

```ts
function mmr(candidates: Chunk[], k: number, lambda = 0.5) {
  const selected: Chunk[] = [];
  const remaining = [...candidates];
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0, bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i];
      const maxSim = selected.length === 0
        ? 0
        : Math.max(...selected.map(s => cosine(c.embedding, s.embedding)));
      const mmrScore = lambda * c.score - (1 - lambda) * maxSim;
      if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = i; }
    }
    selected.push(remaining[bestIdx]);
    remaining.splice(bestIdx, 1);
  }
  return selected;
}
```

`lambda = 0.5` でrelevance/diversity を5:5。

### 4.5 L4.5 — pending task results の注入 (Phase C以降)

Phase 1 ではテーブル空でno-op。Phase C で本格活用。

```sql
SELECT id, agent_name, task_type, output, completed_at
FROM tasks
WHERE pending_acknowledgement = TRUE
  AND status = 'succeeded'
  AND (session_id = $current_session OR session_id IS NULL)
ORDER BY completed_at ASC;
```

応答後、Yui がその結果について発話したかをツール経由 or 出力パースで検知し、`pending_acknowledgement = FALSE` + `acknowledged_at = NOW()` を立てる。

外部システムのイベント (例: ユーザーが Plane でタスクを完了した) は別経路:

- Plane webhook → `/api/plane-webhook` → 注目すべき変化なら `memory_chunks` に `chunk_type='event'`、`source_system='plane'`、`source_id=...` で記録
- これは L4 (semantic retrieval) からヒットすれば Yui が気付ける
- 「絶対に気付かせたい」イベントは L4.5 と同じ仕組みで `tasks` に `initiated_by='webhook'` で擬似タスクを作る方式も可能

### 4.6 プロンプトへの注入形式

system block は **3つ** 並べる:

1. **人格 (キャッシュ対象)** — Yui の system prompt 本体、変化しない
2. **現在の状況 (動的、毎ターン更新)** — 日時など
3. **記憶 (動的、毎ターン更新)** — L2/L3/L4 (実装は §4.5/§5)

```
## 現在の状況
- 日時: 2026年5月24日(日) 15:30 (JST)
- 結衣の発言で日付や曜日に触れる場合は、この情報を真として扱ってください。
```

```
## 結衣の記憶

### ご主人様について大切なこと (常時の記憶)
[事実]
- ユーザーは魚アレルギー
- ユーザーの犬の名前はミロ

[好み]
- 和食派、特に煮物が好き

### 最近のお話 (直近のセッション要約)
- (3日前) 新しいコーヒー豆を試した話で盛り上がった
- (5日前) VRMキャラの開発で詰まっていた

### 今の話題に関連する記憶

[出来事]
- (5/14 (10日前)) プレゼンを終えて疲れていた様子

[感情パターン]
- (3日前) コーヒー話題で機嫌が良くなる傾向

[外部システム情報 (Phase B以降)]
- Plane PROJ-123 (年次レビュー資料、due 5/30): 毎年プレッシャーで疲弊するパターン

[サブエージェントの結果 (Phase C以降)]
- (10秒前) research_agent: 土曜夜のイタリアン候補3軒見つかった
   → 自然な形でユーザーに伝えるか、文脈に応じて判断してください

これらは会話の参考までに。明示的に話題に出すかは文脈次第 (全部披露しない)。
```

**時間表記の方針** (`src/lib/time.ts`):
- `fact / preference / procedural` は時間情報を付けない (timeless)
- `summary / turn_summary / event / emotion / task_result` は冒頭に相対時刻 (今日/昨日/N日前/M/D (N日前)/YYYY/M/D (N日前)) を付与
- 表示は常に JST (Asia/Tokyo)、コンテナ TZ には依存しない (Intl.DateTimeFormat に明示)

「明示的に話題に出すかは文脈次第」と付記する重要性: 全部の記憶を披露する変なAIにならないため。
特に pending task は「ユーザーが今別の話題を始めていても、機会を見て切り出す」ニュアンスを Claude に伝える。

## 5. 書き込み戦略

### 5.1 raw_messages: 毎ターン即時

```ts
// 応答返却後にバックグラウンドで insert (応答をブロックしない)
await db.insert(raw_messages, [
  { session_id, role: 'user', content: userMsg },
  { session_id, role: 'assistant', content: reply, emotion },
]);
```

### 5.2 memory_chunks: セッション末抽出 (Phase 1)

**トリガー**:
- セッション内最終操作から **10分無操作** → セッション終了とみなす
- ユーザーが明示的に「これ覚えておいて」と発話したターン → 即時抽出 (single fact)

**抽出フロー**:

1. raw_messages から該当 session_id を全件取得
2. 抽出プロンプトと共に Claude (Haiku) に投げる
3. JSON 配列で返ってきた items を memory_chunks に insert (embedding付与)

抽出プロンプト雛形 (中立第三者視点):

```
以下は AI キャラクターとユーザーの一連の会話です。
将来この会話を忘れた状態で会話を再開した場合に「思い出しておきたい項目」を抽出してください。

抽出ルール:
- ユーザーに関する事実 / 好み / 制約は必ず拾う (例: アレルギー、職業、家族構成、趣味)
- 出来事 (何が起きた、何をした) は日付付きで拾う
- 感情パターン (このトピックで嬉しそう、等) を拾う
- 表面的な天気の話、定型的な挨拶は拾わない
- 中立な第三者視点で書く ("ユーザーは…" と書き、"あなた" "ご主人様" は使わない)
- 各項目は1〜3文の独立したステートメントにする (将来の検索でヒットしたとき単独で意味が通るように)

出力は JSON 配列:
[
  {
    "type": "fact" | "preference" | "event" | "emotion" | "summary",
    "content": "...",
    "importance": 0.0〜1.0
  }
]

importance の付け方:
- 1.0: アレルギー・健康・約束など忘れると重大
- 0.7: 強い好み、繰り返し語られる関心事
- 0.5: 一般的な情報
- 0.3: 一過性の話題

会話:
<raw_messages を ROLE: content の形式で連結>

JSON のみ出力。説明文不要。
```

抽出後の処理:
- `type='summary'` で短いセッション要約も1件含める (L3 で使う)
- 全 items を embed → memory_chunks に insert

### 5.3 Rolling extraction (Phase 3 を前倒し実装)

セッション末トリガー (「またね」等) は会話を綺麗に締めない限り発火しないため、UX 上は記憶が定着しない。これを解決するためメッセージ累積でも自動発火させる。

実装:
- **トリガー**: 未抽出 raw_messages 件数が `ROLLING_EXTRACTION_THRESHOLD` (デフォルト10件 ≈ 5ターンペア) 以上で発火
- **abstract type 制限なし**: fact / preference / event / emotion / summary すべて抽出 (turn_summary 専用ではない)
- **provisional flag**:
  - importance は 0.6 に cap
  - metadata に `{provisional: true, extraction_kind: 'rolling'}` を付与
  - 後の session-end 抽出 or reconciliation で supersede されやすくする
- **idempotency**: `extraction_progress` テーブルで session毎に last_extracted_message_id を保持。rolling と session-end が同じ範囲を二重処理しない

```sql
CREATE TABLE extraction_progress (
  session_id                TEXT PRIMARY KEY,
  last_extracted_message_id BIGINT NOT NULL DEFAULT 0,
  last_extracted_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 5.4 Stale session extraction (孤児セッション対策)

短い会話 (10メッセージ未満) で離脱した場合、rolling threshold に届かないため抽出されない。これを補う:

- **判定**: 未抽出 ≥ 2 件 AND 直近メッセージが 5分以上前 のセッションを抽出対象
- **発火タイミング**:
  - コンテナ起動後の最初のリクエスト (lazy startup)
  - チャットリクエストごとに 5分debounce で再チェック
- **実装**: `src/lib/extract.ts::processStaleSessions()`、`src/lib/startup.ts::tickMaintenance()`
- **Phase G** で cron 経由に移行予定 (現状は request-driven)

### 5.5 Background reconciliation (記憶矛盾解決)

ADD-only 戦略 (Mem0 v3 派生) は古い間違いがそのまま残るので、抽出後に semantic に近い既存 chunk を見つけて Claude で矛盾判定する。

実装 (`src/lib/reconcile.ts`):

```
extractIncremental 完了 → newChunkIds[]
  ↓ (fire-and-forget)
reconcileNewChunks(newChunkIds)
  並列で:
    各 new chunk について:
      1. findSimilarChunks (cosine sim > 0.7, same chunk_type, 自分以外)
      2. Claude (Haiku) に "supersedes" vs "consistent" を判定させる
      3. supersedes 判定された既存chunkは invalidated_at = NOW()
         + metadata に invalidation_reason / invalidated_by_chunk_id
```

判定対象 type: `fact / preference / procedural / external_ref` のみ。
`summary / emotion / event` は補完情報として扱うので reconcile しない。

設計判断:
- **慎重さ重視**: prompt に「迷ったら consistent」を明記、誤って正しい記憶を消すリスクを下げる
- **soft invalidation**: 削除でなく flag、監査トレイル保持
- **chat 応答レイテンシゼロ**: 完全にバックグラウンド (応答返却後に走る)
- **コスト**: 1 chunkあたり ~$0.0005 (Haiku)、典型的に5 chunk並列で <1秒

### 5.6 月次 dedup (将来、必要なら)

`reconciliation` が日常運用ではdedup相当の役割を果たすので、追加バッチは当面不要。
将来 reconciliation で取りこぼした完全重複を掃除したい場合:

```sql
-- 同 chunk_type 内で類似度 > 0.95 のペアを抽出し、importance低い方を invalidate
WITH duplicates AS (
  SELECT a.id AS keep_id, b.id AS drop_id
  FROM memory_chunks a, memory_chunks b
  WHERE a.id < b.id
    AND a.chunk_type = b.chunk_type
    AND a.embedding <=> b.embedding < 0.05
    AND a.importance >= b.importance
    AND a.invalidated_at IS NULL AND b.invalidated_at IS NULL
)
UPDATE memory_chunks
SET invalidated_at = NOW(),
    metadata = metadata || '{"invalidation_reason": "monthly dedup"}'::jsonb
WHERE id IN (SELECT drop_id FROM duplicates);
```

## 6. embedding モデル

**bge-m3** を LAN 上の llama.cpp (`llama-embed.service`) でホスト、OpenAI互換 `/v1/embeddings` で叩く (1024次元)。

選定理由:
- 完全無料、LAN内なのでレイテンシ ~80-110ms
- bge-m3 は多言語SOTAクラス、日本語雑談も十分こなす
- OpenAI互換APIなので将来 OpenAI/Voyage/Cohere に切替易

```ts
// OpenAI互換のためバッチ可能、input_type 区別なし
await embed(["query text", "document text"]);  // → number[][]
```

環境変数 (defaults in docker-compose.yml):
```
EMBED_URL=http://embed-host:8082/v1/embeddings
EMBED_HOST_IP=10.0.0.10            # (例) 自宅 LAN の embed サーバ IP、extra_hosts で解決
EMBED_MODEL=bge-m3
EMBED_DIMENSIONS=1024
```

将来モデルを変える可能性に備えて、`memory_chunks` の metadata に `embedding_model` を残せる枠は確保 (現状は記録していない、必要になったら埋める)。次元数が変わったら別カラム or 新テーブル + 再embed バッチ。

### 検討した代替

| モデル | コスト | 日本語精度 | 採用しなかった理由 |
|---|---|---|---|
| Voyage `voyage-3-large` | $0.18/1M | ◎ | LAN bge-m3 でも実用上十分、外部API依存削減 |
| OpenAI `text-embedding-3-large` | $0.13/1M | ○ | bge-m3で代替可能、外部API回避 |
| Cohere `embed-multilingual-v3` | $0.10/1M | ○ | 同上 |
| OpenAI `text-embedding-3-small` | $0.02/1M | △ | 精度差大きい |

## 7. インフラ構成 (Docker)

`docker-compose.yml` に追加 (実装ベース):

```yaml
services:
  web:
    # 既存
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      - DATABASE_URL=${DATABASE_URL:-postgres://vroid:vroid@postgres:5432/vroid}
      - EMBED_URL=${EMBED_URL:-http://llm:8082/v1/embeddings}
      - EMBED_MODEL=${EMBED_MODEL:-bge-m3}
      - EMBED_DIMENSIONS=${EMBED_DIMENSIONS:-1024}
    # 外部ホスト (= 自宅 LAN / Tailscale / VPS で TTS / Embedding を別サーバ運用する場合) を
    # コンテナ内から解決したい時は、`.env` で IP を定義してから以下のように追加:
    # extra_hosts:
    #   - "tts-host:${TTS_HOST_IP:-127.0.0.1}"      # TTS
    #   - "embed-host:${EMBED_HOST_IP:-127.0.0.1}"  # bge-m3 embedding

  postgres:
    image: ankane/pgvector:latest
    container_name: vroid-postgres
    environment:
      - POSTGRES_USER=vroid
      - POSTGRES_PASSWORD=vroid
      - POSTGRES_DB=vroid
    volumes:
      - postgres_data:/var/lib/postgresql/data
    ports:
      # ホストから psql inspection 用。5432 はホスト postgres と衝突するので 5433。
      - "127.0.0.1:5433:5432"
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U vroid"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  postgres_data:
```

マイグレーション実行: `docker compose exec web npm run db:migrate`

## 8. 実装フェーズ

### Phase 1: 最小動作 — 記憶 retrieval & insert (推定: 半日) ✅ 完了

**ゴール**: 過去会話の semantic recall が出来る最小構成

- [x] docker-compose に postgres+pgvector 追加
- [x] migration: `raw_messages` + `memory_chunks` + `tasks` + `proactive_state` の全テーブル作成 (`tasks` は schemaのみ、Phase 1 では未使用)
- [x] DB クライアント (Drizzle ORM + postgres-js)
- [x] embedding クライアント (Voyage → bge-m3 local に変更、§6 参照)
- [x] `/api/chat` 改修:
  - 毎ターン raw_messages に insert
  - クエリ embed → semantic 検索 top-K
  - system prompt に retrieved を注入
  - actor_type='extraction' で書き込み統一
- [x] セッション末抽出 (明示トリガーのみ: ユーザーが「ばいばい」「またね」等で締めたら抽出)
- [x] 現セッション除外を撤回 (実装してから判明したUX問題、§4.2 で記載)

### Phase 2: A + B の統合 (推定: 1日) ✅ 完了

- [x] L3: 直近3セッション要約の system prompt 注入 (`loadRecentSummaries`)
- [x] L2: importance 高 fact の always-on 注入 (top-N=10) (`loadAlwaysOnFacts`)
- [x] 時間減衰スコアリング (TAU=30d、Phase 1 で実装済)
- [x] MMR dedup (λ=0.5)
- [x] BM25 ハイブリッド (semantic 0.7 + lexical 0.3、Phase 1 で実装済)
- [x] セッション末トリガーの自動化 (5分アイドル + コンテナ起動時、`processStaleSessions`)
- [x] L2/L3/L4 重複除去 (excludeIds)
- [x] format: 各層に見出しを付けて Claude が区別できるように

### Phase 3: Rolling extraction & 自動化 (推定: 半日) ✅ 完了 (Phase 2と一緒に前倒し)

- [x] 10メッセージ毎の rolling extraction (`ROLLING_EXTRACTION_THRESHOLD`)
- [x] `extraction_progress` テーブルで idempotency 確保
- [x] provisional flag (importance cap 0.6) で session-end / reconcile に supersede されやすく
- [x] **背景の reconciliation** (Mem0 v3 ADD-only の発展、§5.5 参照)
- [ ] 月次 dedup バッチ (reconciliation で代替、必要なら追加)
- [ ] 「これ覚えておいて」等の明示記憶コマンド検知 → 即時 fact insert (actor_type='user_direct')

### Phase B: 外部システム連携 (実装中)

**ゴール**: Yui が Plane / GCal / Gmail などを (specialist 経由で) 参照・操作できる

- [x] **方針確定**: MCP プロトコルではなく direct REST + Claude SDK tools (§13.2)
- [x] **Specialist パターン導入** (Tier 1 orchestration): `src/lib/specialists/` (§14.1)
  - 各 domain = 1 file、registry が Yui 用 wrapper を自動生成
  - Yui の prompt や /api/chat はドメイン追加時に触らない
- [x] **Plane**: `task_specialist`、REST client (`lib/plane.ts`)
- [ ] **GCal**: `schedule_specialist` (REST or MCP 経由)
- [ ] **Gmail**: `mail_specialist`
- [ ] 外部システム情報の文脈オーバーレイ:
  - 重要な外部イベントが発生したらメモリ抽出時に `chunk_type='external_ref'` + `source_system` + `source_id` を付与
  - 例: 「PROJ-123 (年次レビュー) でユーザーはプレッシャーを感じている」
- [ ] Plane webhook 受け口 (`/api/webhooks/plane`): 注目すべきイベントを memory_chunks に event として記録
- [ ] `procedural` chunk_type の活用 (ユーザーのルーチン記憶)

### Phase C: バックグラウンドタスク (推定: 1〜2日)

**ゴール**: Yui が時間のかかる処理を非同期で実行し、結果を自然に会話に折り込む

- [ ] `tasks` テーブルを本格活用
- [ ] タスク dispatcher: chat ハンドラから fire-and-forget で背景ジョブ起動 (Next.js Route Handler + setImmediate, または BullMQ等のジョブキュー)
- [ ] L4.5 (pending task results) の system prompt 注入
- [ ] ack 検知ロジック (Yui が結果について発話したら pending=FALSE)
- [ ] commitment chunk_type の活用 (Yui の約束を tracking)
- [ ] 簡単なバックグラウンドエージェント (1〜2種、e.g., web検索, レストラン検索) を main_chat から直接Claudeで実装 (まだ Managed Agents 不要)

### Phase D: サブエージェント orchestration (推定: 3〜5日)

**ゴール**: 「Yuiの部下たち」が独立した文脈で並列に複雑タスクを処理

- [ ] orchestration framework 選定の最終確定 (推奨: Anthropic Managed Agents、§14参照)
- [ ] サブエージェント定義 (research_agent / email_agent / scheduling_agent 等)
- [ ] 各サブエージェントの memory READ 権限・記憶への書き込み権限を実装
  - 読み: semantic search (フィルタなし、Yui と同じ範囲を見せる)
  - 書き: `actor_type='subagent', actor_id=<agent_name>`
- [ ] サブエージェント結果の集約 (Managed Agents multiagent coordinator パターン)
- [ ] チャンク先頭で `source_system`/`actor_type` の絞り込み付き retrieval をテスト

### Phase F: Discord text bot (推定: 1日)

**ゴール**: Discord DM / 指定 channel から Yui に話しかけられる

- [ ] `apps/discord-bot/` 新設 (別 Docker サービス, Postgres は共有)
- [ ] discord.js v14+ で Bot 登録 (個人 Discord で applications.bot 作成)
- [ ] オーナー認証: `.env` に `DISCORD_OWNER_ID` をハードコード、それ以外の DM は無視
- [ ] DM/メンション/特定 channel に反応
- [ ] 受信: Discord message → POST `/api/chat` (source='discord_text')
- [ ] 送信: chat reply を `message.reply()` で返す
- [ ] 長文の分割 (Discord は 2000字制限)
- [ ] TTS は Discord text では使わない (テキストのみ)

詳細は §15.2 参照。

### Phase G: Proactive autonomy (推定: 1.5日)

**ゴール**: 5分おきにカレンダー/メール/Plane をチェックして必要なら自律発話

- [ ] cron 駆動の `/api/cron/check` エンドポイント実装
- [ ] 状態差分検知: GCal/Gmail/Plane を MCP 経由で取得し、前回チェック以降の変化を抽出
- [ ] 2段階フィルタ: ハードルール (always/never) + LLM フィルタ (borderline)
- [ ] 報告すべきイベントを `tasks(initiated_by='cron', task_type='proactive_notification')` に insert
- [ ] 通知配信先: Discord (Phase F) / Web push (将来) / 両方
- [ ] rate limit と quiet hours の実装
- [ ] last_check_at の永続化 (Postgres に key-value テーブル or `tasks.metadata` で)
- [ ] idempotency (同じイベントを重複報告しない)

詳細は §16 参照。

### Phase H: Discord voice (推定: 3〜5日)

**ゴール**: Discord voice channel で Yui と音声対話

⚠️ 他フェーズより難度が一段高い。Phase F/G が安定してから着手推奨。事前に prototype 作成を強く推奨。

- [ ] `@discordjs/voice` + `prism-media` セットアップ
- [ ] Bot が voice channel に join できる slash command (`/yui-join`)
- [ ] ユーザー音声の購読 (per-user PCM stream)
- [ ] VAD (silero-vad などのONNX runtime) で発話区間検出
- [ ] STT: Whisper (ローカル or Deepgram API)
- [ ] STT 結果を `/api/chat` に source='discord_voice' で送信
- [ ] reply text を既存 TTS endpoint で WAV 化
- [ ] WAV → Opus encode → voice channel に送信
- [ ] 中断対応 (ユーザーが Yui の発話を遮ったら止める)
- [ ] reconnect 処理 (voice gateway は不安定)

詳細とリスクは §15.3 参照。

### Phase E 以降 (任意・将来)

- [ ] facts の管理 UI (web画面で閲覧/編集/削除)
- [ ] Graphiti風 bi-temporal の有効化 (UPDATE系操作の追加)
- [ ] embedding モデルの再評価 / マイグレーション
- [ ] Compaction 連携 (Sonnet/Opusに切り替える場合)
- [ ] Anthropic Memory tool 併用 (Claudeが能動的に過去掘れるように)
- [ ] (マルチユーザー対応はノンゴールなので永久にやらない)

## 9. 観測性・運用

### 9.1 ロギング

`/api/chat` ハンドラで以下を構造化ログ:

```json
{
  "session_id": "...",
  "turn": 7,
  "query_embed_ms": 118,
  "retrieval_ms": 32,
  "retrieved_chunk_ids": [42, 71, 88, 99, 103],
  "claude_ms": 487,
  "tokens_in": 1620,
  "tokens_out": 84,
  "cache_read": 0,
  "cache_write": 0,
  "emotion": "happy"
}
```

### 9.2 メトリクスとして見たいもの

- 平均検索ヒット数 (top-K に何件入ったか)
- 抽出失敗率 (LLMがJSON以外を返した回数)
- memory_chunks 総数の推移
- dedup で消えた件数
- 平均応答レイテンシ (各層の内訳)

最小実装は console.log で十分。後日 OpenTelemetry なり Grafana なり。

### 9.3 デバッグ用ツール

- `/api/debug/memory?q=...` → 与えたクエリで何が引っ張られるかJSONで返す (本番では無効化)
- `psql` から `SELECT id, chunk_type, importance, content FROM memory_chunks ORDER BY created_at DESC` で生確認

## 10. セキュリティ・プライバシー

- 個人用シングルユーザー前提なので、DBは Docker volume にしか書かない (クラウド同期しない)
- embedding は LAN bge-m3 (`http://llm:8082`) 経由なので外部APIキー不要
- 個人情報抽出に強い抑止はかけない (本人のチャット記録なので)
- `raw_messages.content` には平文で会話が残る → DBバックアップ取り扱いは個人裁量

将来クラウドへ移すなら:
- DBの暗号化 (at rest)
- セッション境界の明示
- ユーザー削除コマンド (GDPR的)
- これらはノンゴール

## 11. 決定事項ログ (Decision Log)

調査と議論で確定した方針:

| 決定事項 | 採用案 | 却下案と理由 |
|---|---|---|
| 全体方向 | facts + summary + pgvector ハイブリッド | Mem0/Letta 採用 (理由: Yui人格統合不可、依存追加コスト) |
| メイン記憶 | extraction後の memory items を embed | 生turn を embed (理由: semantic類似 ≠ memory関連性) |
| 抽出ロジック | Mem0 v3パターン (single-pass ADD-only) | Mem0 v2パターン (ADD/UPDATE/DELETE/NOOP 判定LLM) |
| 矛盾解決 (Phase 1) | 蓄積型、最新優先で読む | UPDATE/DELETE、LLM判定 |
| **矛盾解決 (Phase 3 改訂)** | **抽出後にバックグラウンドで semantic similar chunk を見つけて Claude 矛盾判定、supersede flag** | ADD-only のみ (理由: 古い間違いが残り続けるUX問題)、UPDATE直接 (理由: 監査トレイル失う) |
| Memory tool 公式 | 採用しない (受動注入のみ) | 採用 (理由: tool useオーバーヘッド、雑談には不要) |
| **embedding (2026-05-23 改訂)** | bge-m3 (llama.cpp LANホスト) | Voyage `voyage-3-large` (理由: LAN無料、bge-m3 で精度十分、外部API依存削減) |
| DB | pgvector 別コンテナ | SQLite-vss / Qdrant / 既存DB なし |
| 抽出トリガー | セッション末 + 明示「覚えて」 + rolling 10メッセージ + 5分stale | 毎ターン (コスト高) / バッチのみ (応答性悪) / セッション末のみ (UX悪) |
| 抽出視点 | 中立第三者視点 | キャラ視点 (再利用しにくい) |
| 検索 | hybrid (semantic 0.7 + BM25 0.3) + 時間減衰 (τ=30d) + MMR (λ=0.5) | semanticのみ (固有名詞弱い)、MMR無し (重複多い) |
| 直近文脈含めた検索 | last 2 user turn + current を連結してembed | current のみ (参照詞で空振り) |
| 長時間セッション | rolling extraction (10メッセージ毎) を Phase 3 前倒し実装 | Claude Compaction (Haikuで使えない) |
| **rolling provisional 扱い** | importance 0.6 cap + metadata.provisional=true | 普通の重みで insert (理由: 訂正前に extract された fact が高 importance だと困る) |
| **stale session 抽出** | 5分アイドル + 起動時 lazy check + 5分debounce | cron only (理由: Phase G まで cron 無いから request-driven にしておく) |
| **時間コンテキスト** | 毎ターン JST の datetime block を system に挿入 + chunk に相対時刻 | (時刻なし) (理由: Yui が「いつの話か」分からないと記憶を文脈化できない、Phase G 以降のスケジュール判断にも必須) |
| **タイムゾーン** | JST 固定、Intl で明示 | コンテナ TZ に依存 (理由: portable、設定漏れリスク回避) |
| 将来Graphiti移行 | スキーマに valid_to/invalidated_at だけ予約 | フル実装 (YAGNI) |
| **外部システム** | SoTを尊重、ローカルにフルミラーしない、source_id で薄く連携 | フルミラー (理由: 同期コスト、2つのSoTでバグ温床) |
| **ユーザーTODO** | Plane に置く (canonical)、Yui は MCP経由で参照 | localに重複保持 |
| **Yui内部タスク** | local `tasks` テーブル (Plane汚さない) | Plane に専用project (理由: Yuiノイズで Plane汚れる) |
| **actor/source provenance** | Phase 1 から schema 入れる | 後で migration (理由: 後付けmigration面倒) |
| **chunk_type の語彙** | §3.3 で集中管理、TEXT カラムで拡張可 | enum (理由: enum migrate面倒、自由度欲しい) |
| **orchestration framework (Tier 2)** | 推奨: Anthropic Managed Agents (Phase D で確定) | LangGraph (Python first / ランタイム分離コスト)、自前 (耐久性弱い) |
| **Tier 1 specialist (Phase B 改訂)** | 同期 in-process specialist (runner + registry + 1file/domain)、Yui からは `ask_<domain>_specialist({query})` で見える | direct tool use (Yui に全ツール直接持たせる) (理由: ツール増加でprompt肥大、compound query で並列化できない、新規領域追加コスト高) |
| **Specialist の出力形式** | ファクトのみ簡潔 (口調作らない) | 散文 (Yui 口調風) (理由: Yui が再整形するので二重作業、Yui の人格が薄まる) |
| **Specialist 通信方式 (2026-05-24 改訂)** | **Async (SSE push)**: Yui即時 ack → background で完了 → SSE で別message として届く | Sync (Yui が specialist 結果を await) (理由: ユーザー体感レスポンスが12秒→2秒に短縮、原案の "Yui即返、部下が裏で確認→報告" vision そのまま) |
| **Voice formatter** | specialist 完了後に Yui voice で再整形する追加 LLM call を入れる | specialist の text を生で push (理由: Yui の人格・口調が崩れる、ユーザー体験的に統一感ない) |
| **SSE 接続管理** | session 毎に in-memory subscriber registry (Map<session_id, Set<controller>>) | Redis pub/sub (理由: 単一プロセスなら不要、将来マルチプロセス化したら差替え) |
| **Yui 向け wrapper の粒度** | ドメイン単位 (task / schedule / mail ...) | 機能粒度細かく (cal_get / cal_create / cal_update) または ざっくり work_specialist 1つに統合 (理由: ドメイン単位が一番自然、領域間連携は compound query で並列対応) |
| **MCP vs direct fetch** | direct fetch (Tier 1) | MCP プロトコル (理由: LLM が discover しない用途では overhead、Tier 2 で必要なら mcp_servers パラメータで後付け可) |
| **メインチャットのモデル** | Haiku 4.5 直叩き (低レイテンシ優先) | Managed Agents 経由 (overhead大) |
| **サブエージェントのモデル** | タスクに応じて Opus/Sonnet を使い分け | 統一 (理由: コスト/品質トレードオフ柔軟性) |
| **マルチユーザー** | 永久にやらない (個人用システム) | Phase E に置く (理由: 個人用と明言されたため) |
| **マルチインターフェース** | `/api/chat` を core にし adapter で接続 | 各 interface 専用 endpoint (理由: 記憶共有が複雑化) |
| **session_id の境界** | 連続会話で1セッション、interface跨いでも同一可 (時間ギャップで切る) | per-interface session 完全分離 (理由: 連続性が損なわれる) |
| **retrieval の現セッション扱い (2026-05-23 改訂)** | 現セッションも含めて検索 | 現セッション除外 (理由: ページリロードで messages[]が失われると同セッション内の過去記憶が見えなくなる) |
| **interface 識別** | `raw_messages.source` カラム (web/discord_text/discord_voice/cron) | metadata JSONB 内 (理由: 分析クエリしにくい) |
| **proactive cron** | tasks テーブルに `initiated_by='cron'` で投入 → L4.5 経由で発火 | 別テーブル (理由: 既存仕組みで自然に乗る) |
| **proactive フィルタ** | 2段階 (hard rules + LLM) | LLM のみ (理由: 重要事項を絶対漏らさないため hard 必須) |
| **Discord 認証** | オーナー Discord ID をハードコード | OAuth ログイン (理由: 個人用なのでオーバーキル) |
| **Discord voice 着手順序** | Phase F/G 後、別途 prototype を先行 | 一気に実装 (理由: 実装複雑度・統合難度高い) |

## 12. オープン質問

- L2 (always-on facts) は何件まで詰める? → 初期値 10件、importance 上位、トークン上限 500 で打ち切り
- セッション境界が曖昧 (デバイス再起動した場合とか) は許容 → 自動 split 必要なら後フェーズで
- VRMキャラの動作 (表情/lipsync) と記憶の連動 → 現状は分離、将来 emotion chunk から動作トリガーを生成する余地
- 多言語化 → 当面日本語のみ、embedding は多言語対応なので将来拡張可
- サブエージェントが書き込んだ chunk を main chat の retrieval から除外する/しない の運用ポリシー → Phase D で実機検証してから決める
- Plane webhook のフィルタ条件 (どんなイベントを記憶に流すか) → Phase B で実機を見ながら絞る

## 13. 外部システム連携方針

### 13.1 哲学

外部システム (Plane / GCal / Gmail / Todoist 等) は **Single Source of Truth として尊重する**。ローカル DB にフルミラーは作らない。Yui 側で持つのは:

- **構造データへの参照** (`memory_chunks.source_id` 経由)
- **構造には乗らない文脈オーバーレイ** (感情、パターン、約束等)

例:

```
Plane (canonical)                    memory_chunks (overlay)
─────────────                        ─────────────────────
issue PROJ-123                       id: 8421
  title: 年次レビュー資料         ◄─ source_system: 'plane'
  state: in_progress                 source_id: 'PROJ-123'
  due: 2026-05-30                    chunk_type: 'emotion'
                                     content: "PROJ-123は年次レビューで
                                              毎年プレッシャー、3週間前
                                              から触り始めるパターン"
```

### 13.2 接続方法の優先順位 (2026-05-24 改訂)

1. **REST API 直叩き** (採用) — LAN内で低レイテンシ、PAT 認証で単純、Cloudflare/OAuth不要
2. Webhook (push 型) — 注目イベントを Yui に通知したい場合に追加
3. MCP 経由 — 将来 Phase D で Managed Agents subagent が外部 MCP サーバを使うときに検討

なぜ MCP を選ばなかったか: MCP は「LLM がツールを discover する」プロトコル。我々のように
backend (Next.js) で直接 fetch するだけなら、ツール記述/スキーマネゴ/SSE ハンドリングは
overengineering。Anthropic SDK 標準の `tools` パラメータで宣言するのが最も筋がよい。

### 13.3 取得タイミング

外部システムを叩くのは **会話の文脈で必要になったタイミングのみ**:

- ユーザーが「今日の予定は?」と聞いた → GCal を MCP で取得
- ユーザーがメール返信を依頼 → Gmail を MCP で取得

**常時自動注入はしない** (毎ターン API 叩くと遅い + 課金)。MCP の tool use 機構で Claude が必要時に発火する自然な形が良い。

### 13.4 取得結果のメモリ化

外部システムから取った情報を全部 memory_chunks に保存するわけではない。**残すのは情景・文脈レベルで意味があるもの**:

- ✓ 「ユーザーが毎週月曜にプレゼン準備で詰まっている」 (パターン)
- ✓ 「PROJ-123 は内心嫌々やっている」 (感情)
- ✗ 「明日の予約は 10:00」 (構造データ、GCal を見れば分かる)
- ✗ 「メール件名XX」 (Gmail を見れば分かる)

判断は **抽出時のプロンプトで Claude に判断させる** (構造データの単純コピーは抽出しないと指示)。

### 13.5 Webhook 連携 (Phase B+)

外部システムでの変化を Yui が気付くべき場合:

```
Plane でユーザーが PROJ-123 を完了
   ↓ Plane webhook
   ↓
/api/webhooks/plane → memory_chunks に
   chunk_type='event'
   source_system='plane', source_id='PROJ-123'
   content="5/24 14:30、ユーザーが年次レビュー資料を完了にした"
   ↓
次のチャットで L4 (semantic) から自然にヒット可能
   ↓
あるいは "絶対に気付かせたい" イベントは tasks に擬似タスクとして
   initiated_by='webhook', pending_acknowledgement=TRUE で投入
```

GCal の reminder、Gmail の重要メールも同パターン。

## 14. Orchestration 層の設計

Yuiの「部下」は **2階層** で構成する:

| 階層 | 名前 | 実行場所 | 通信方式 | 寿命 | Phase |
|---|---|---|---|---|---|
| **Tier 1: Specialist** | 各業務領域の "事務員" | Next.js プロセス内 (background job) | **SSE push (async)** | 数秒〜十数秒 | **B (実装済)** |
| **Tier 2: Managed Subagent** | 重い作業の "部下" | Anthropic クラウド container or Agent SDK on subscription | SSE push + L4.5 acknowledge | 数分〜数時間 | D (将来) |

Yui からはどちらも tool として見える:
- `ask_<domain>_specialist({query})` → Tier 1 (fire-and-forget、結果は SSE で別メッセージとして到達)
- `spawn_<task>_subagent({...})` → Tier 2 (将来、より長時間)

### 14.1 Tier 1: Specialist (Phase B 実装済み)

**Async + SSE push** が原則。Yui は specialist 結果を待たず、ack を即返してそのまま終了。
結果は background で完了次第 SSE で別 message として client に push される。

```
[T+0]   user 発話 → POST /api/chat
[T+2s]  Yui (Haiku LLM call 1):
        - "かしこまりました、確認いたしますね" (テキスト)
        + tool_use ask_task_specialist({query: "..."})
        → サーバ: dispatchSpecialistJob() で background spawn
        → サーバ: response { reply, pendingJobs: [{jobId, specialist}] } を返す
[T+2s]  client: Yui の ack 表示 + "確認中…" spinner 表示

  ─────── 裏で進む ───────
[T+2〜10s] specialist runner: Claude tool-use ループで Plane 等を叩く
[T+10s]   完了 → Yui voice formatter (LLM call 2) で 結衣口調に整形
[T+12s]   pushToSession(sessionId, { type: 'yui_message', text, emotion })
          → SSE 経由で client に届く
  ────────────────────────

[T+12s] client: SSE で受け取った Yui 追加メッセージを履歴 append + TTS 再生
        → spinner 消去
```

**実装ファイル**:
- `src/lib/specialists/types.ts`: `Specialist` 型定義
- `src/lib/specialists/runner.ts`: 汎用 tool-use ループ runner (background job 内で呼ばれる)
- `src/lib/specialists/registry.ts`: specialist 登録 + Yui 用 wrapper tools 自動生成
- `src/lib/specialists/{task,schedule,mail,research,...}.ts`: 各 specialist (1 file)
- `src/lib/jobs/events.ts`: SSE subscriber registry (session_id → controllers)
- `src/lib/jobs/dispatcher.ts`: spawn 関数 + Yui voice formatter
- `src/app/api/chat/stream/route.ts`: SSE endpoint
- `src/app/api/chat/route.ts`: spawn のみ、await しない

**新しい specialist を増やすときに必要なもの**:
1. `src/lib/specialists/<id>.ts` を 1 ファイル書く (~100-200 行)
2. `registry.ts` に 1 行登録 (`{ spec, isAvailable }`)
3. **Yui の prompt や /api/chat や SSE は触らない**

**役割分担の鉄則**:
- **Specialist** = ファクト取得係。短く構造化された情報のみ返す。口調を作らない。
- **Voice formatter (Yui LLM call 2)** = specialist の結果 + 元のユーザー質問を受けて、結衣の口調と長さに整える。
- **Yui (初回 LLM call 1)** = ack 1文 + tool_use 発行のみ。重い整形をしない。

**レイテンシ実測** (Plane task query):
- Yui 即時 ack: ~2秒 (ユーザーは2秒で何か返事が見える)
- specialist 完了 + voice formatter: ~7〜10秒 (background)
- ユーザー体感: 2秒で ack → 10〜12秒後に詳細結果

旧 sync 実装 (~10〜15秒で1メッセージ) と比べて:
- 体感レスポンス: 2秒 vs 12秒 → **6倍速く感じる**
- 総処理時間: ほぼ同じ (むしろ voice formatter 分わずかに増える)
- compound query (3 specialist 並列): ack 2秒、結果は specialist 完了毎に逐次到達 (10秒前後)

### 14.2 Tier 2: Managed Subagent (Phase D)

```
Yui (Tier 1 と同じ Haiku 直叩き)
  ↓ tool use: spawn_research_subagent({topic})
  ↓ (fire-and-forget で tasks に insert、即時 ack を user に返す)
  ↓
Managed Agents session
  - research_agent (Opus、深掘り)
  - 数分〜数時間
  - 完了時 tasks.output 更新 + memory_chunks.task_result 投入
  ↓
次の Yui chat turn
  - L4.5 (pending task results) から拾われる
  - Yui が「先ほどの件、結果出ました」と切り出す
```

### 14.3 フレームワーク選定 (Tier 2)

| 選択肢 | 強み | 弱み | この用途 |
|---|---|---|---|
| **Anthropic Managed Agents** (β) | Claude 公式、per-session container、SSE stream、multiagent coordinator | β、Anthropic lock-in | ◎ 「Yuiの重い部下たち」とドンピシャ |
| LangGraph | 成熟、サブエージェントパターン豊富 | Python first、TS 機能差、別ランタイム | ○ Python担当者の知見あれば |
| Inngest / Trigger.dev | 耐久性 job queue、TS native | LLM 特化機能なし | ○ シンプルなタスクのみなら |
| 自前 (Promise + DB) | 最小依存 | 耐障害性自前 | △ プロト止まり |

**推奨**: Phase D で Anthropic Managed Agents を採用。

Tier 1 の specialist は Tier 2 移行の足がかり: specialist の `systemPrompt` + `tools` 一式を `agents.create({...})` に流用可能。

### 14.2 フレームワーク選定

| 選択肢 | 強み | 弱み | この用途 |
|---|---|---|---|
| **Anthropic Managed Agents** (β) | Claude 公式、per-session container、SSE stream、multiagent coordinator | β、Anthropic lock-in | ◎ 「Yuiの部下たち」とドンピシャ |
| LangGraph | 成熟、サブエージェントパターン豊富 | Python first、TS 機能差、別ランタイム | ○ Python担当者の知見あれば |
| Inngest / Trigger.dev | 耐久性 job queue、TS native | LLM 特化機能なし | ○ シンプルなタスクのみなら |
| 自前 (Promise + DB) | 最小依存 | 耐障害性自前 | △ プロト止まり |

**推奨**: Phase D で Anthropic Managed Agents を採用。理由:

- Yui の人格設定を coordinator agent の system prompt にそのまま入れられる
- multiagent coordinator (1.0 GA) パターンで部下たちを roster 化できる
- per-session container でサブエージェントが任意の bash / code execution / MCP を使える
- SSE で Next.js に結果ストリーミング → main chat の L4.5 に流せる
- Anthropic に既に課金しているので追加依存なし

ただし **メインチャット自体は Managed Agent 経由にしない** (Direct API のレイテンシが必要)。Managed Agent は重いタスク専用。

### 14.3 Sub-agent の memory アクセス権限

| 操作 | 権限 |
|---|---|
| memory READ (semantic search) | 全 subagent に許可 |
| memory WRITE (task_result chunk) | 自分が完了したタスクの結果のみ。`actor_id` 必須 |
| memory WRITE (fact / preference 等) | 不可 (main chat の抽出経由でのみ追加) |
| tasks READ | 自分が担当するタスクのみ |
| tasks WRITE (status / output) | 自分が担当するタスクのみ |
| 外部システム書き込み | tasks の `external_ref_*` に記録、コミット前に Yui の承認待ち (Phase E) |

### 14.4 main chat ↔ subagent の連携プロトコル

1. **kick**: main chat が tool use で `spawn_research_agent({topic})` を呼ぶ
2. **dispatch**: handler が `tasks` に insert (status='pending') + Managed Agents session を非同期起動
3. **immediate ack**: main chat は「少々お時間いただきますね」等の即時返答
4. **subagent execution**: Managed Agent が走り、tools を使い、結果を出力
5. **completion hook**: SSE で完了イベント受信 → `tasks.status='succeeded'`, `output={...}`, `pending_acknowledgement=TRUE`, `memory_chunks` に task_result chunk insert
6. **acknowledgement**: 次の chat turn で L4.5 から読まれる → Yui が自然に切り出す
7. **clear**: ack 検知 → `pending_acknowledgement=FALSE`

### 14.5 セキュリティ・スコープ

- サブエージェントは **読み取り権限はYuiと同等** だが、書き込みは制約あり (上記表)
- 機微情報 (パスワード等) はそもそも memory_chunks に保存しない (抽出プロンプトで除外指示)
- サブエージェントの実行ログ (Managed Agents の event stream) は別途保存して監査可能
- ユーザーが「あの部下に任せた件キャンセル」と言ったら `tasks.status='cancelled'` を立てる + session を terminate

## 15. Multi-interface 設計 (Phase F+)

### 15.1 全体像

Yui agent core (Claude call, memory, tools) は **インターフェース非依存**。入出力は adapter pattern で分離する。

| インターフェース | 入力経路 | 出力経路 | Phase |
|---|---|---|---|
| Web UI | Fetch POST `/api/chat` | SSE / JSON response | 0 (現状) |
| Discord text | discord.js → Bot → POST `/api/chat` | Bot が `message.reply()` | F |
| Discord voice | Discord voice → STT → POST `/api/chat` | TTS WAV → Opus → voice channel | H |
| Cron | scheduled trigger → POST `/api/cron/check` → 内部で `/api/chat` 同等処理 | 通知配信 (Discord push 等) | G |

各 interface adapter は:
- 入力を `{ messages, source, destination, metadata }` の共通形式に正規化
- core の応答を destination に応じた形式で返す (text / SSE / TTS bytes / Discord embed等)

### 15.2 Discord text bot (Phase F)

**実装方針**:
- `apps/discord-bot/` を新規ディレクトリで分離
- 別の Docker サービスとして起動 (`vroid-discord-bot`)
- Postgres / `/api/chat` を Next.js コンテナと共有
- 単一プロセス、起動時に Discord gateway に WebSocket 接続

**ファイル構成 (案)**:
```
apps/discord-bot/
├── Dockerfile
├── package.json
├── src/
│   ├── index.ts          # Bot 起動 + gateway 接続
│   ├── auth.ts           # オーナー Discord ID 確認
│   ├── handlers.ts       # message handler
│   └── chat-client.ts    # Yui core への HTTP POST
```

**主要ロジック**:
```ts
client.on(Events.MessageCreate, async (message) => {
  if (message.author.id !== process.env.DISCORD_OWNER_ID) return;  // 認証
  if (message.author.bot) return;
  if (!message.mentions.has(client.user) && message.channel.type !== ChannelType.DM) return;
  
  await message.channel.sendTyping();
  const reply = await fetch(`${YUI_API}/api/chat`, {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "user", content: message.content }],
      source: "discord_text",
      destination: { channel_id: message.channel.id, message_id: message.id },
    }),
  });
  const { text } = await reply.json();
  
  // Discord は 2000字制限、超えたら分割
  for (const chunk of chunksOf(text, 1900)) {
    await message.reply(chunk);
  }
});
```

**設計上の判断**:
- 認証は `DISCORD_OWNER_ID` 1個ハードコード (個人用なのでこれで十分)
- DM か Bot メンションのみ反応 (チャンネル全体への自動反応はしない)
- TTS は Discord text では使わない (テキスト返信のみ)
- core が L1〜L4.5 retrieval を実行、結果テキストを返す。Bot 側は薄い proxy

### 15.3 Discord voice (Phase H)

**事前評価**: 他フェーズより明らかに難度高い。**Phase F/G が安定してから着手**。事前に最小prototype (Bot が voice channel に join して "hello" を喋るだけ) を1日で作って実装可否を確認。

**技術スタック**:
- `@discordjs/voice` — voice gateway 操作
- `prism-media` — Opus encode/decode
- VAD: `@ricky0123/vad-web` (Silero VAD ONNX) or `webrtcvad-wasm`
- STT: Whisper (`whisper.cpp` ローカル) or Deepgram API (有料、低レイテンシ)
- TTS: 既存 `/api/tts` endpoint をそのまま流用

**フロー**:

```
1. ユーザーが Bot を voice channel に invite (slash command /yui-join)
2. Bot join → connection.receiver.subscribe(userId) で per-user PCM stream を購読
3. VAD で発話区間を検出 (~10ms フレーム単位で speech/silence 判定)
4. 発話完了 (1秒以上 silence) でバッファを Whisper に投げて文字起こし
5. POST /api/chat with source='discord_voice', destination={voice_channel_id}
6. reply text を /api/tts で WAV 化
7. WAV → Opus encode → connection.subscribe(player) で channel に流す
8. ループ
```

**レイテンシ予算 (目標)**:
- VAD で発話終了検出: ~500ms (silence wait time)
- Whisper STT (ローカル base モデル): ~800ms
- Yui chat 応答: ~700ms
- TTS: ~800ms
- **合計: ~2.8秒** (ユーザー発話完了から Yui発話開始まで)

リアルタイム会話としては少し遅いが許容範囲。Deepgram などのストリーミング STT に切り替えれば1秒台も可能 (有料)。

**リスクとハマりどころ**:
- voice gateway の reconnect 処理 (頻繁に切れる、自動 reconnect ロジック必要)
- 複数人 voice channel での話者分離 — シングルユーザーなので発話者は1人想定で OK だが、別の人が同じ voice channel にいる場合の挙動を決める (無視 / mute 等)
- Yui発話中にユーザーが割り込み (barge-in) — VAD で検出して Yui の TTS 再生を中断
- Discord Bot の voice 権限 (Connect / Speak permissions)
- WebRTC の jitter / packet loss
- macOS で開発する場合 `prism-media` のネイティブビルド (opusscript fallback あり)

**実装規模**: prototype 1日 + 本実装 2〜4日 = 計 3〜5日

## 16. Proactive autonomy (Phase G)

### 16.1 設計

Yui 自身は "常駐プロセス" ではなく、cron 駆動の独立トリガー。

```
Every N分 (default 5分):
1. 状態取得
   - GCal: 今後 60分以内の予定
   - Gmail: 未読の最新 N件 (importance フラグ付きを優先)
   - Plane: 期限切迫タスク、自分にアサインされた新規
   - last_check_at 以降の差分のみ取得
2. 変化検知
   - 新規イベント / 重要メール / 期限間近タスクを特定
   - 既に notify した item は除外 (idempotency: tasks に過去ログ照会)
3. フィルタ (2段階)
   - ハードルール: always_notify (15分以内予定、緊急フラグ付きメール等)
   - LLM フィルタ: borderline cases を Claude (Haiku) で判定
4. 通知配信
   - 該当ありなら Discord に push (or 設定された channel)
   - tasks に initiated_by='cron', task_type='proactive_notification' で記録
   - pending_acknowledgement = TRUE で次回チャットでも Yui が触れる
5. last_check_at 更新
```

### 16.2 フィルタ詳細

**ハードルール (always notify、LLM 不要)**:
- 15分以内のカレンダー予定
- 当日中に期限のタスクで status='in_progress' でないもの
- 「重要」フラグ付きメール
- ユーザーが明示的に「これ来たら教えて」設定したパターン

**ハードルール (never notify)**:
- 1時間以内に既に類似 item を報告した
- 静音時間帯 (default 23:00 - 7:00) ※ criticalフラグなら例外
- レート制限: 1時間に最大3通

**LLM フィルタ (Claude Haiku, ~$0.0005/call)**:
- 上記の中間ゾーンを Claude に「これをユーザーに今伝えるべきか? なぜ?」と質問
- 構造化出力: `{should_notify: bool, reason: string, urgency: 0..1}`
- urgency > 0.6 なら配信

### 16.3 cron 実装方式

| 方式 | 長所 | 短所 |
|---|---|---|
| (a) node-cron (Next.js プロセス内) | 開発しやすい、設定不要 | プロセス死んだら止まる |
| (b) Linux cron → curl /api/cron/check | シンプル、外部依存ゼロ | localhost cron 必須 |
| (c) Vercel Cron / Railway Cron | 外部スケジューラ | ローカル開発と差が出る |
| (d) BullMQ Repeatable | 耐久性あり、複数 job 管理可 | Redis 追加 |

個人用なら **(a) か (b)** で十分。Phase G 着手時に開発環境 (Docker) では (a) を採用。

### 16.4 通知メッセージの口調

Yui の人格を保ったまま、proactive 文脈を意識:

```
"失礼いたします、ご主人様。
15分後に田中様との会議のお時間です。
資料はデスクトップの『会議用』フォルダにございましたよ。"

"申し訳ございません、お休み中かもしれませんが、
上司の山田様から至急の旨でメールが届いております。
お手すきの際にご確認くださいませ。"
```

実装: Claude にプロンプトで「あなたから話しかけるシチュエーション、人格を保って簡潔に、ユーザーが今他のことをしている可能性も配慮」と指示。

### 16.5 idempotency と stateの永続化

```sql
CREATE TABLE proactive_state (
  key   TEXT PRIMARY KEY,         -- 'gcal_last_check', 'gmail_last_check', 'plane_last_check'
  value JSONB NOT NULL,           -- {last_check_at, last_seen_ids: [...]}
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

cron 起動時に各 source の last_check / 既見 ID リストを読み、終了時に更新。
このテーブルは小規模だが永続化が必要 (再起動で重複通知しないため)。

### 16.6 シングルユーザー前提の単純化

- proactive notification の宛先は固定 (DISCORD_OWNER_ID か USER_WEB_PUSH_SUB)
- ユーザーごとの notification preference DB は不要
- 設定は `.env` に直書き (QUIET_HOURS_START, RATE_LIMIT_PER_HOUR, etc.)

## 16.7 既知の問題と改善ロードマップ

2026-05-30 の audit で抽出した、現アーキテクチャの問題点と対応方針。

| # | 問題 | 影響 | 優先度 | 着手状態 |
|---|---|---|---|---|
| 1 | **decay 機構なし** — 古い preference が永久に重み保持 (例: 1 年前の「ラーメン好き」が今も importance 0.6) | retrieval ノイズ蓄積、新しい嗜好が古いものと等価扱い | 高 | 未着手 |
| 2 | **再強化機構なし** — 100 回言及された事実と 1 回だけの事実が同 importance | 重要度の解像度が低下、L4 retrieval の精度頭打ち | 中 | 未着手 |
| 3 | **手動編集 UI なし** — 「これ違う」とユーザーが直接訂正できない | 誤った記憶を会話で訂正 → reconcile 任せの不確実な経路のみ | 高 | **着手中 (オプションに記憶タブ)** |
| 4 | **importance 横並び** — LLM 抽出時に 0.5/0.6 を置きがちで解像度低い | 重要度ベースの優先順位が機能不全 | 中 | 未着手 |
| 5 | **owner 分離なし** — preference に「ユーザー」と「結衣ペルソナ」が混在 | retrieval 時に Yui 設定をユーザー嗜好として誤読、ニュースキュレーション等で精度悪化 | 高 | **着手中 (即 Phase 1)** |
| 6 | **temporal reasoning が弱い** — created_at は記録するが「○月時点ではこう」の時間軸理解が浅い | 過去の状態と現在の状態を区別できず矛盾を見落とす | 低 | 未着手 |
| 7 | **invalidated chunk のクリーンアップなし** — 行は永久に残る | 年単位運用でテーブル肥大化 (現時点では問題なし) | 低 | 未着手 |
| 8 | **抽出の質に root されてる** — extract が偏ると memory もノイジーに | reconcile は部分補正のみ、最初の抽出が重要 | 中 | extract prompt 段階的改善 |
| 9 | **chunk 間の関連グラフなし** — 「ミロ → 犬 → ペット」連鎖がない | Zep / Graphiti 級の reasoning は不可 | 低 | 個人用なら過剰、後日評価 |

### 改善計画 (順序)

**Phase 1: Owner 分離 (即着手)**
- `memory_chunks` に `owner` カラム追加 (`'user' | 'assistant' | 'shared'`)
- 値は `raw_messages.role` と同じ呼称で統一 (秘書の名前は persona で可変なので "yui" 等のハードコードは避ける)
- 抽出 prompt を「主語が秘書 or ご主人様」判定するよう更新
- retrieval queries で owner フィルタを追加
- ニュースキュレーション (今回保留中) もこれを使う

**Phase 2: 手動編集 UI**
- SettingsModal に新タブ「記憶」追加
- chunk_type / owner / 検索でフィルタ、編集 / 重要度調整 / 無効化
- `actor_type='user_direct'` を実際に使う

**Phase 3: importance 解像度改善**
- 抽出 prompt に「重要度判断基準」を具体例で示す (1.0 ≒ 一生忘れない誕生日、0.5 ≒ 偶発的嗜好、0.2 ≒ 一時的状態)
- LLM 出力の 0.5/0.6 偏りを観測 → 必要なら post-process 正規化

**Phase 4 (撤回 → 4'): extract-time dedup を reconcile に統合**
- 旧 Phase 4 (extract 時に embedding only で dedup) は **意味的類似 ≠ 内容一致** を区別できず誤動作する
  (例: 「腕が痛い」と「腕が治った」を embedding 類似度で同一視 → 矛盾を「重複」と誤判定して boost する)
- 撤回し、reconcile 側に `duplicate` verdict を追加して LLM 判定で扱う (下記 Phase 4')

**Phase 4': reconcile に duplicate verdict 追加**
- reconcile の Haiku judgment を 3 値に拡張: `duplicate | consistent | supersedes`
- `duplicate`: 完全同義の言い換え → NEW を invalidate + OLD の importance を +0.05 boost
- `consistent`: 補完情報、別側面 → 両方残す (既存挙動)
- `supersedes`: 矛盾 / 訂正 / 状態変化 → OLD を invalidate (importance 高くても)、NEW を残す
- prompt に「duplicate と supersedes は **意味が同じか反対か** で区別」を明示
- 失敗時は consistent 寄せで誤消去回避 (既存と同じ fail-safe)
- metadata に `reinforced_at / reinforce_count` を蓄積 (decay 保護判定に使う)

**Phase 5: retrieval ログ + decay (業務用設計)**

新規スキーマ:
```sql
-- 「いつどの chunk が retrieval で使われたか」を append-only で記録
CREATE TABLE retrieval_log (
  id BIGSERIAL PRIMARY KEY,
  chunk_id BIGINT NOT NULL REFERENCES memory_chunks(id) ON DELETE CASCADE,
  session_id TEXT,
  retrieved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  layer TEXT NOT NULL,        -- 'l2_facts' | 'l3_summary' | 'l4_semantic' | 'reconcile' | 'extract_dedup'
  rank INT,                    -- 0-based 順位
  score REAL                   -- cosine sim or importance score
);
CREATE INDEX idx_retrieval_log_chunk_recent ON retrieval_log (chunk_id, retrieved_at DESC);
CREATE INDEX idx_retrieval_log_recent ON retrieval_log (retrieved_at DESC);

-- decay 日次ジョブの監視ログ
CREATE TABLE decay_runs (
  id BIGSERIAL PRIMARY KEY,
  ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed INT NOT NULL,
  decayed INT NOT NULL,
  invalidated INT NOT NULL,
  errors INT NOT NULL DEFAULT 0,
  duration_ms INT,
  details JSONB                -- 分布ヒストグラム等
);
```

decay ロジック (日次 04:00 JST):
- 「未参照」= retrieval_log に直近 30 日のエントリなし AND created_at > 30 日前
- 段階レート (importance 依存):
  - `importance ≥ 0.9` → 不変 (絶対忘れない: アレルギー、誕生日等)
  - `0.7 ≤ x < 0.9` → ×0.99 (緩やか、年 ×0.7 相当)
  - `0.5 ≤ x < 0.7` → ×0.97 (中速、年 ×0.3 相当)
  - `x < 0.5` → ×0.95 (急速、年 ×0.15 相当)
- `reinforce_count ≥ 3` なら decay rate を半分 (「繰り返し言及されたもの」を保護)
- `importance < 0.05` になったら自動 invalidate
- 並行性: 1 chunk 1 transaction、per-row try/catch で全体停止せず
- decay_runs に集計 + 分布記録、観測可能に

retrieval_log 記録 (各 retrieval 経路で fire-and-forget):
- `loadAlwaysOnFacts` / `loadRecentSummaries` / `retrieveRelevant` の末尾で batch INSERT
- transaction 外で実行 (wall latency に影響ゼロ)
- 失敗しても retrieval 本体には影響させない

**Phase 6: temporal reasoning**
- chunk metadata に `valid_from / valid_until` を追加 (期間性のある事実用)
- 抽出 prompt で「これは○月までの状態か」を判定
- 当面の優先度低、必要性が出てから着手

**Phase 7: cleanup (業務用設計)**

定期 cleanup ジョブ (週次 日曜 03:00 JST):
- `retrieval_log`: 1 年経過の row を物理削除 (今後 partitioning も検討)
- `memory_chunks`: invalidated_at + 180 日経過の行を物理削除 (FK CASCADE で retrieval_log も消える)
- `decay_runs`: 3 ヶ月以上前の集計は削除 (短期傾向だけ見られれば十分)
- 各削除件数を console.log で記録

将来の scale 対応 (現状は不要だが設計上の備え):
- retrieval_log は将来的に PostgreSQL native partitioning (月次) で性能維持
- decay_runs は monthly partition 不要 (日 1 行のみ)

**Phase 8: 観測性 (業務用設計)**

新規エンドポイント `/api/memory/stats`:
```json
{
  "total": 633, "valid": 612, "invalidated": 21,
  "byType": {"fact": 169, "preference": 170, ...},
  "byOwner": {"user": 575, "assistant": 30, "shared": 28},
  "importanceBands": {"0.9+": 25, "0.7+": 80, "0.5+": 320, "<0.5": 187},
  "decay": {"lastRun": "...", "decayedLast7d": 45, "invalidatedLast7d": 3},
  "topReinforced": [{"id", "content", "reinforce_count"}, ...],
  "retrievalActivity": {"totalLast7d": 1240, "uniqueChunks": 387}
}
```

MemorySection に折りたたみ可能な統計パネル追加。トレンド可視化で運用判断材料を提供。

**Phase 9 (任意): chunk グラフ**
- Graphiti 風 entity 関連グラフ
- 大規模工事。実用性が要件として浮上した時点で評価

### 改善設計の原則 (この章全体に適用)

- **業務用に劣らない設計を主推奨**。「個人用なら簡易で十分」という妥協は採らない
- 並行性・冪等性・観測性・audit trail を最初から組む
- シングルユーザー前提を残して良いのは「認証・権限・マルチユーザー分離」のみ (§1 参照)
- 「データ整合性・観測性・拡張性」は妥協領域ではない

## 17. 参考文献

- [Anthropic Memory tool](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool)
- [Mem0 GitHub / docs](https://github.com/mem0ai/mem0)
- [Letta docs](https://docs.letta.com/concepts/letta)
- [Graphiti GitHub](https://github.com/getzep/graphiti)
- [A-MEM (arXiv 2502.12110)](https://arxiv.org/abs/2502.12110)
- [State of AI Agent Memory 2026](https://mem0.ai/blog/state-of-ai-agent-memory-2026)
- [Voyage embeddings docs](https://docs.voyageai.com/)
- [pgvector GitHub](https://github.com/pgvector/pgvector)
