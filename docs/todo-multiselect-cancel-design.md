# TODO モーダル 複数選択一括編集 + 中止ステータス — 設計書

> ステータス: 設計 (Codex レビュー 1 回反映済 / 再レビュー前)
> 作成日: 2026-06-24
> 対象: TodoModal / ProjectHubModal / /api/todos / src/lib/todos.ts / todo tools / status 分岐サイト

## 0. 目的

1. TODO モーダルを、メールモーダルと同じ複数選択 UX にする。複数選択したら右ペインに一括編集パラメータを並べ、保存で一括更新する。
2. 新ステータス「中止 (cancelled)」を追加する。完了でも未着手でもなく「もうやらないと決めた」もの。done 同様に活動リストから隠すが、完了実績には数えない。

## 1. 確定仕様 (ユーザー確認済み)

- **中止の集計**: 活動リストからは done 同様に隠す。**「今日の完了数」/ XP / 達成統計には含めない**。
- **プロジェクト統合**: projects テーブルは触らない。選択した TODO の project を 1 つに**付け替えるだけ**。空になった重複プロジェクトの自動アーカイブはしない。
- **一括編集対象**: title / note / url は対象外。対象は project / state / priority / start_at / due_at / tags。
- **タグの一括**: 複数選択時、選択 TODO のタグの**和集合**をパネルに初期表示する。タグ欄を有効化して保存すると、**パネルのタグ集合を選択全 TODO に適用 (置換)** する。
  - 例: A=[本], B=[緊急] を選ぶと初期表示 [本, 緊急]。無編集のまま (タグ欄有効) 保存で A も B も [本, 緊急] になる。パネルから消したタグは全 TODO から外れる。
  - 適用は §4.2 の**変更検知 (dirty) 方式**に従う。タグ欄を編集した時だけ置換適用。未編集なら各 TODO のタグはそのまま。

## 2. 現状の事実 (調査 + コード確認済み)

- `todos.state` は**制約なしの text** (`src/db/schema.ts:529`、`migrations/0011_todos.sql:20` も check/enum なし)。現値 `backlog | in_progress | blocked | done`。
  → **「中止」追加に DB migration は不要**。アプリ層の enum / label / 分岐のみ更新。
- `updateTodo()` (`src/lib/todos.ts:254`): `projectName` (名前、null で解除) を受ける。`state==='done'` で `completedAt` セット・それ以外で null・done で XP。**グローバル `db` を直接使い、tx ハンドルを受けない**。**reminder cleanup は含まない**。
- `completeTodo()` (`todos.ts:304`): `updateTodo(state:'done')` + `cleanupTodoReminders()`。reminder 片付けは**この経路だけ**。単票 PATCH (`/api/todos/[identifier]`) は `updateTodo` を呼ぶだけなので **done にしても reminder は消えない** (既存の不整合)。
- `sleep-intro.ts:76`: `completedAt >= startToday` のみで「今日完了した todo」を拾う (**state 条件なし**)。
- XP backfill script `seed-xp-from-history.ts:87`: `completedAt IS NOT NULL` を todo_completed として XP 付与。
- dedup active 判定は `["backlog","in_progress","blocked"]` (`todos.ts:197`, `intent/route.ts:115,199`)。done/cancelled 非含 → 中止でも同 title 再追加可。
- メール複数選択は `checked:Set / selectMode / anchorId` + `POST /api/mail/batch {ids, patch}`。

## 3. 中止ステータス cancelled の設計

### 3.1 セマンティクス

| 観点 | 挙動 |
|---|---|
| 活動リスト表示 | done 同様に既定で隠す (default filter を `NOT IN ('done','cancelled')` に) |
| **completed_at** | **セットしない (null のまま)**。→ sleep-intro・XP backfill 等「completedAt 非 null = 完了」を見る箇所を汚染しない (§3.2 の判断)。専用「中止」グループ表示で、並びは既存ソート (completed_at が null なので due/priority/created 順) に従う。特別な並び替えは導入しない |
| XP | 付与しない (done のみ。updateTodo の XP 分岐は done 限定のまま) |
| 完了統計 (今日/今週の完了数) | 数えない。`stats.doneToday/Week` は `state='done'` なので自然に除外 |
| dedup | active 集合に含めない (現状のまま) → 再追加可 |
| reminder | cancel 時にも片付ける (§3.3 で updateTodo に集約) |
| UI cycle ボタン | cycle には入れない (`backlog→in_progress→done→backlog` のまま)。中止は state ドロップダウン / 一括パネルから設定 |
| グルーピング | モーダルでは done と同様に期限バケットから分離し、専用「中止」グループに置く |

### 3.2 変更が要る status 分岐サイト (Codex レビューで追補)

- `src/lib/todos.ts`
  - `updateTodo()`: state 分岐に cancelled を追加。**completed_at はセットしない** (done のみセット、cancelled 含むそれ以外は null クリア)。reminder cleanup を集約 (§3.3)。
  - `listProjectsWithCounts` 系 active count (`todos.ts:114` `state <> 'done'`) → `NOT IN ('done','cancelled')`。
  - 既定リストフィルタ (`todos.ts:372-375` の default `!= 'done'`) → `NOT IN ('done','cancelled')`。
  - `formatTodoListMarkdown()` (`todos.ts:476`): state ラベルの default-backlog で cancelled が「未着手」誤表示になる → cancelled ラベルを追加。
- `src/app/api/todos/route.ts:51`: 既定フィルタ同上。
- `src/app/api/todos/stats/route.ts`:
  - `doneToday/doneThisWeek` (l.93-94): 変更不要 (done 限定)。
  - `byState` (l.79): cancelled を**含める** (TodoModal に中止フィルタチップの件数を出すため)。
- `src/lib/user-profile.ts:279-290`: if-chain に `else if (state==='cancelled')` を追加 (backlog に混ぜない)。
- `src/components/ProjectHubModal.tsx`: `TodoState` 型 (l.56) に cancelled、`STATE_LABEL` (l.345 参照) に "中止"、未完判定 `state !== "done"` (l.314) を `!== "done" && !== "cancelled"` に。
- `src/app/api/projects/[id]/hub/route.ts:92-98`: `todoByState` は動的バケットなので破綻なし。ラベルのみ。
- `src/lib/morning-brief.ts:107`: active states 固定で cancelled 非含 → 変更不要。
- `sleep-intro.ts` / `seed-xp-from-history.ts`: §3.1 で **completed_at を cancelled に付けない**ことで誤集計を回避するため、**変更不要**。

### 3.3 reminder cleanup の集約 (既存不整合も是正)

- 現状、reminder 片付けは `completeTodo()` だけ。単票 UI PATCH で done にしても reminder が残る不整合がある。
- 本改修で `updateTodo()` 内に、`state` が `done|cancelled` に設定された時の `cleanupTodoReminders(row.id)` を移す (冪等。再 cleanup は無害)。
- `completeTodo()` は `updateTodo(state:'done')` を呼ぶだけにし、重複 cleanup を除く。
- **これは単票 PATCH→done の挙動も変える (reminder が消えるようになる)**。意図的な整合修正として扱う。承認時に明示する。

### 3.4 enum / label / tools

- `TodoModal.tsx`: `TodoState` (l.29), `STATES` (l.58), `STATE_LABEL` (l.60: `cancelled:"中止"`), 色クラス、グルーピング (l.511 で done と並ぶ専用 group)。cycle (l.1193) 据え置き。
- tools: `add_todo.ts:21` / `update_todo.ts:18` / `list_todos.ts:17` の enum、`mcp/tools-todo.ts:47` の zod `STATE`、`UpdateTodoInput.state` (`todos.ts:248`) に `"cancelled"` 追加。`complete_todo` は done 固定。
- (任意) update_todo description に「中止 = もうやらないと決めたもの」を一文。
- 既定フィルタが `NOT IN ('done','cancelled')` になるため、`include_completed`/`include_done` 系の説明 (`list_todos.ts:8`, `mcp/tools-todo.ts:91`) を「完了・中止 (inactive) も含める」に更新する。

## 4. 複数選択一括編集の設計

### 4.1 フロント (TodoModal.tsx)

メールモーダルのパターンを移植。

- state 追加: `checked:Set<number>`, `selectMode:boolean`, `anchorId:number|null`, `visibleIdsRef`。
- ヘッダに「選択モード」トグル。ON で行に checkbox、OFF で `checked` クリア。
- 行クリック: shift=範囲 / ctrl|meta=トグル / 通常=詳細 (selectMode 中はトグル)。mail の `handleRowClick` 踏襲。
- 右ペイン分岐: `selectMode && checked.size>0` で単票詳細でなく**一括編集パネル**。
- 行 CSS: `.todo-row.checked / .select-mode` を mail に倣う。

### 4.2 一括編集パネル (右ペイン)

「変更した項目だけ更新、触っていない項目はそのまま」を、**変更検知 (dirty tracking) 方式**で実現する。各フィールドは選択 TODO の現状を初期表示し、**ユーザーが変更したフィールドだけ** patch に含める。enable チェックは設けない。

初期表示ルール:
- 選択 TODO 全件で値が**一致**するフィールド → その値を初期表示。
- 値が**混在**するフィールド → `（混在）` プレースホルダ表示 (= 未変更扱い)。混在のまま保存すれば各 TODO の値は維持される。
- ユーザーがそのフィールドを具体値に変更 → dirty 化 → patch に含めて**全選択 TODO に適用**。

| フィールド | 初期表示 | patch (変更時のみ) |
|---|---|---|
| project | 共通 project / `（混在）` | `project` = **プロジェクト名 \| null** (UI の選択 id → 名前に変換。名前は UNIQUE) |
| state | 共通 state / `（混在）` | `state` (backlog/in_progress/blocked/done/**中止**) |
| priority | 共通 priority / `（混在）` | `priority` (1/2/3) |
| start_at / due_at | 共通日付 / `（混在）` | `start_at` / `due_at` (ISO \| null。クリアも変更扱い) |
| tags | 選択 TODO のタグ**和集合**を seed 表示 | `tags` (編集時のみ。パネル集合で全選択 TODO を置換) |

- dirty 判定: 初期表示値からの差分を持つフィールドのみ送る。`（混在）`プレースホルダを触らなければ未送信。
- 「保存」で `{ids:[...checked], patch}` を送る。`patch` は **dirty フィールドのみ** (= 空 patch なら no-op)。
- 保存後 `checked` クリア + reload。
- title / note / url は載せない。

### 4.3 バックエンド

- 新規 `POST /api/todos/batch`、body `{ ids:number[], patch:{ project?:string|null, state?, priority?, start_at?:string|null, due_at?:string|null, tags?:string[] } }`。
- 新規 `batchUpdateTodos(ids, patch)` を `src/lib/todos.ts` に追加。
  - **真の atomic batch にはしない**。`updateTodo()` がグローバル `db` 直書きで tx を共有できないため。**best-effort 逐次**で、id ごとの成否を集めて返す (`{ updated:number, failed:[{id, code}] }`)。todo 編集は低リスクなので部分成功を許容。**「1 transaction」とは謳わない**。
  - **per-id の `code` は固定コードのみ** (`"not_found" | "invalid_patch" | "update_failed"`)。生 `e.message`/`String(e)` を response に乗せない (CLAUDE.md エラー規約)。詳細は `console.warn` で server log に。
  - **id→identifier の解決を 1 回の `id IN (...)` クエリで前段取得**し (N+1 回避)、各 identifier に対し `updateTodo()` を呼ぶ。副作用 (XP/reminder/link sync/completed_at) を単票と完全一致させる狙い。
  - `patch.project` は `projectName` として `updateTodo({projectName})` に渡す。tags は置換 (updateTodo の `input.tags!==undefined` で配列置換、確認済 `todos.ts:257`)。patch に無いキーは触らない。
- **入力検証 (新規 route で厳格化)**: `ids` は整数配列・空不可・上限 (例 500)・重複除去。`patch` は空不可。`state` は enum (cancelled 含)、`priority` は 1|2|3、`tags` は string[]、日付は ISO\|null。検証 NG は 400。
- 認証は既存 todos route と同じ (cookie `vroid-auth` / `X-Internal-Auth`、`proxy.ts`)。catch は CLAUDE.md 規約の `clientError()` で固定文返却。

## 5. エッジ / 判断ポイント

1. **completed_at を cancelled に付けない**: sleep-intro・XP backfill・将来の「completedAt=完了」前提を汚さないため。並び替えは updated_at。
2. **reminder cleanup の集約は単票 PATCH→done の挙動も変える** (§3.3)。意図的整合修正として承認時に明示。
3. **一括 done で XP が件数分発火**: 選択 N 件 done → XP イベント N 件。仕様上妥当として per-todo XP 踏襲 (UNIQUE 制約で再 done は重複しない)。気になれば後日「一括時抑制」を別途。
4. **batch は部分成功あり** (非 atomic)。UI は失敗件数を表示し reload。
5. **project 付け替えの primary/link 整合**: updateTodo 経由で `syncPrimaryProjectLink` が効く。
6. **tags 和集合はフロントで union** (サーバ往復不要)。タグ欄を編集しなければ未送信 (置換しない)。
7. **DB migration 不要** (state 制約なし)。check 制約導入は今回しない。
8. **過去 XP は取り消さない**: `addXp()` は insert-only で取消機構がない (`xp.ts:81`)。一度 done になって todo_completed XP が付いた TODO を後で cancelled にしても、その XP は残る (既存の done→backlog でも戻らないのと同じ)。§1「cancelled は XP に含めない」は「cancel が XP を**付与しない**」の意で、既得 XP の遡及取消はしない。これは稀な経路 (完了→中止) なので許容し、明記に留める。

## 6. テスト計画

- 型/lint: `npm run typecheck` / `npm run lint`。
- ケース:
  - cancelled に更新 → 活動リストから消える / completed_at は null / XP 増えない / 今日の完了数・sleep-intro の今日完了に出ない / reminder が消える。
  - cancelled の TODO と同 title を再追加 → dedup されず追加可。
  - ProjectHub で cancelled が未完件数・一覧に出ない / ラベル "中止" 表示。
  - 複数選択 → project 一括付け替え → 全件 project 変更。
  - 複数選択 → state 一括 done → 全件 done + 完了数反映 / reminder 片付け。
  - 複数選択 → tags 欄有効化・和集合表示 → 1 つ消して保存 → 全件から消える。
  - 部分更新: priority だけ有効化 → 他フィールド不変。
  - batch 一部失敗 (存在しない id 混在) → 成功分は反映・失敗件数表示。
- 手動: 選択モード toggle / shift 範囲 / ctrl トグル / 保存後 reload。

## 7. 非対象 (今回やらない)

- projects テーブルの統合・マージ・自動アーカイブ。
- title / note / url の一括編集。
- 一括 done 時の XP 抑制。
- state の DB check 制約導入。
