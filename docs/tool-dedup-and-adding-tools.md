# ツール重複実行ガード + ツール追加マニュアル — 設計書

2部構成:
- **Part A**: 会話ターンをまたぐ**重複実行ガード** (`tool_execution_log` reservation + scope/anchor + embedding 類似)。
- **Part B**: 新しいツールを足す時の**チェックリスト**。

関連: `docs/tool-dispatch-redesign.md` (§5.5 dispatchTool、§12 ツール検索)。

---

## Part A. 重複実行ガード

### A1. 背景・問題

- #2 (Executor) は会話履歴を受け取るため、**過去ターンの依頼を再実行**する (実機: 「佐久に予定入れて」の後に
  「ゴミ捨てリマインダー」で佐久も再登録)。さらに**微妙に違う引数で重複作成** (実機: 「岡谷との予定」「岡谷に
  行く予定」が同日同時刻で両方登録)。
- 既存の **per-request idempotency** (`dispatch.ts` DispatchLedger) は**同一 `runExecutor` 呼び出し内**だけ。
  会話ターンまたぎ・別 args (文字違い)・別 request 並行 を防げない。
- query rewriting は誤実行リスクが高く当面見送り → **実行履歴ベースの dedup ガード** (確認ゲートと並ぶ下流の
  安全網、モデル非依存)。

### A2. 配置 = `runTool` 共通層 + `executePendingTool` (dispatchTool だけでは不足、Codex High①)

ツールの実行経路は **3 つ**あり、`dispatchTool` だけに入れると主目的 (specialist 経由の gcal_create_event) を
取り逃がす:

| 経路 | 実体 | dedup を入れる場所 |
|---|---|---|
| 直ツール (Executor) | `dispatchTool` → `runTool` (`runtime.ts`) → handler | runTool |
| **specialist 内部ツール** | specialist runner → **`runTool` を直接** → handler | runTool |
| confirm 承認後 | `executePendingTool` (`confirm.ts`) → **handler を直接** | executePendingTool |

→ **dedup guard は `runTool` に置く** (dispatchTool + specialist を一網打尽)。**confirm 承認実行は
`executePendingTool` 側でも reservation を finalize** する。confirm 必要ツールは runTool が pending を返す時点で
**reservation を予約**し、executePendingTool が executed に更新する (A5)。

### A3. dedup キーの考え方 (なぜ embedding か)

- **生タイトル一致**では「岡谷との予定」≠「岡谷に行く予定」ですり抜ける。
- **時刻のみ**だと同時刻の**別予定**まで誤って弾く。
- → **scope + 時間軸 anchor で粗絞り、衝突時に title embedding 類似で精査**:
  - 「岡谷との予定」≈「岡谷に行く予定」(cosine 高) → 同一意図 → スルー
  - 「13時 会議」vs「13時 ランチ」(cosine 低) → 別物 → 通す
- embedding は既存 `embed()` (bge-m3 / pgvector)。Valkey はベクトル類似が出来ないので **DB テーブル (pgvector)**。

### A4. テーブル `tool_execution_log` (migration 0073)

| カラム | 型 | 用途 |
|---|---|---|
| `id` | bigserial PK | |
| `scope_key` | text | dedup スコープ (例: `calendar:primary` / `session:<id>`)。**session 単位でなく実体単位** (Codex Low) |
| `tool_name` | text | |
| `dedup_anchor` | text | 時間軸の正規化キー。null は `'__null__'` に正規化 (lock/比較のため) |
| `title_text` | text | embedding 元 + デバッグ |
| `title_embedding` | `vector(1024)` | 意味類似判定用 |
| `embedding_model` | text | embed モデル ID (Codex Medium: 異モデルのベクトル比較は無意味) |
| `embedding_dimensions` | int | 次元 |
| `status` | text | `executing` \| `pending_confirmation` \| `executed` \| `skipped` \| `failed` \| `cancelled` |
| `confirm_token` | text null (unique) | confirm 経路の reservation を `executePendingTool` と紐付ける (Codex High②) |
| `args` | jsonb | 監査用 (PII 含む → A8 retention) |
| `created_at` / `updated_at` | timestamptz | 時間窓 + status 更新 |

- HNSW / index / UNIQUE は生 SQL migration 側。引き込み: `(scope_key, tool_name, dedup_anchor, created_at)`。`confirm_token` は unique。
- **衝突対象 status = `executing` + `pending_confirmation` + `executed`** (Codex High①②: auto 実行中の窓 +
  confirm 待ちも重複対象にしないと二重実行/二重ダイアログを許す)。`skipped`/`failed`/`cancelled` は対象外。

### A5. 判定フロー (reservation + advisory lock。race と confirm を解決)

`runTool` で dedup 対象ツール (`tool.dedup` あり) を実行/confirm 生成する**前**に:

1. `scope = tool.dedup.scope(input, ctx)` / `anchor = tool.dedup.anchor(input) ?? '__null__'` を計算。
2. **直列化 (Codex High③)**: `pg_advisory_xact_lock(hashtext(scope|tool|anchor))` を transaction で取る
   (外部 API 実行をまたぐので、reservation row + status で守る。lock は予約挿入の瞬間だけ)。
3. **衝突判定** (lock 下): 同 `scope_key`+`tool_name`+`anchor` かつ `status in (executing, pending_confirmation, executed)`
   かつ `created_at > now() - window` かつ **embedding_model 一致** の行を引く。
   - anchor が `'__null__'` 以外で行があれば → 新 title を embed して候補と cosine。`>閾値` → **重複**。
   - anchor が `'__null__'` → 同 scope+tool+窓 の行に対して embedding (+ A6 の lexical 補助) で判定。
4. **重複なら**: 実行しない。監査のため `status='skipped'` (skipReason=`dedup_recent_execution`) で1行 insert
   (ただし**衝突対象には含めない**)。A7 で C に「既にあるので追加しなかった」を1回報告。
5. **重複でなければ reservation を insert** (embedding は記録のため**予約時に毎回計算**して保存。mutation は低頻度
   なので軽い。「衝突時のみ embed」は誤りなので訂正、Codex Medium):
   - **auto (confirm 不要)**: lock 下で `status='executing'` で insert → handler 実行 → 成功で `'executed'`、
     失敗で `'failed'`。**`executing` の間も衝突対象**なので、実行中に来た 2 request 目を弾ける (Codex High①)。
   - **confirm 必要**: `status='pending_confirmation'` + `confirm_token` (発行した確認 token) で insert → pending を
     返す。`executePendingTool(token)` が **`confirm_token` で該当行を特定**し、承認実行後 `'executed'` /
     拒否・期限切れで `'cancelled'` に更新 (Codex High②: scope/anchor 再計算で探さない)。これで確認待ちの間に
     同じ予定が来ても重複ダイアログを作らない。

### A6. scope / anchor / title 仕様 (tool ごとに明文化、Codex Medium)

雑な `start` 文字列化では timezone/秒/終日/calendar_id で割れる。tool ごとに正規化を定義:

| tool | scope_key | dedup_anchor | title |
|---|---|---|---|
| gcal_create_event | `calendar:<calendar_id\|primary>` | `<開始分(UTC正規化)>\|<終了分 or duration>\|<allDay>` | summary |
| add_reminder | `session:<id>` (or user) | `<scheduleKind>\|<baseAt/baseTime/weekdays>\|<leadMinutes>\|<refTodoId?>` | title |
| create_timer | `session:<id>` | `<kind>\|<durationSeconds or targetAt分>` | label |
| add_todo | `session:<id>` | `'__null__'` (todo は同時刻が普通) → title embedding + `project\|due_at(day)` 補助 + 正規化 title の lexical 併用 (短文 embedding の弱さを補う、Codex Medium) | title |

- 時刻は分単位・UTC・終日フラグで正規化。timezone 表記差を吸収。
- 閾値 `0.85` / 窓 `10分` は仮 → **eval で調整** (textual variant を拾い別物を通す境界)。

### A7. skip の報告 (aggregateForReport との整合、Codex Medium)

- 現行 `aggregateForReport` は `executionState='skipped'` を基本 `continue` で捨てる。
- → `skipReason='dedup_recent_execution'` を追加し、aggregate で `- [重複スキップ] <tool>: 既に同じ予定があるので
  追加しませんでした` を **report** に出す (silent にしない)。per-request の重複と区別したいので
  `duplicate_in_request` (既存) と `dedup_recent_execution` (新) を分ける。
- §5.4.2 の二重応答防止と整合: dedup skip は C を起動して「重複なので追加しなかった」と1回だけ伝える。

### A8. embedding 整合 + cleanup / retention

- **embedding_model/dimensions 不一致**: embed モデル変更後は古い `title_embedding` と新 query の比較は無意味
  → 判定は**現行 embed 設定と一致する行のみ embedding 類似に使う**。不一致行は embedding 比較に使わず、
  **`anchor exact` 単独では弾かない** (同時刻の別予定を巻き込むため、Codex Low)。代わりに
  **`anchor exact` + 正規化 title の lexical 類似 (Jaro/部分一致等)** を満たす時だけ重複とみなす
  (= 文字違いの同一意図を拾い、別物は通す)。embed 再生成 (background) で不一致行を解消するのが本筋。
- **retention / PII** (Codex Low): `args`/`title_text` は予定・連絡先等の個人情報を含む。dedup 判定用は
  **窓より十分長い範囲 (例 24h) で削除**。監査が要るなら redacted args のみ別保存。`created_at` index +
  cleanup job (例: 1h ごと、24h 超を削除)。

### A9. `dedup` を ToolDef のフィールドにする (追加時に書き忘れ防止)

```ts
// types.ts ToolDef に追加 (confirmationPolicy と同じく tool に同梱)
dedup?: {
  scope: (input: unknown, ctx: ToolContext) => string;   // dedup スコープ (実体単位)
  anchor: (input: unknown) => string | null;              // 時間軸キー (null=anchor 無し)
  title: (input: unknown) => string;                      // embedding 用テキスト
  threshold?: number;                                     // cosine 閾値 (既定 0.85)
  windowMinutes?: number;                                 // 時間窓 (既定 10)
  lexicalKey?: (input: unknown) => string;                // anchor 無しツールの補助 lexical (todo 等)
};
```

`dedup` を持たないツール (read / dedup 不要) はガード対象外。

### A10. 未解決・リスク

- 閾値・窓は eval 調整。同時刻に**本当に**別予定2つを素早く入れたい時は閾値/窓で調整 (窓超えれば通る)。
- anchor が曖昧なツール (相対時刻のみ等) は lexical/embedding 単体にフォールバック → 精度低下。
- scope を跨ぐ重複 (別アカウント等) は別意図とみなし対象外。
- reservation の advisory lock は短時間 (予約挿入のみ) だが、外部 API が遅いと pending 行が残る → status 更新と
  cleanup で回収。

---

## Part B. ツール追加チェックリスト

新ツールは以下が**セット**で必要。漏れると「検索に出ない」「重複が防げない」等が起きる。

### B1. ツール定義 (`src/lib/tools/<domain>/<name>.ts`)
- `name` / `description` / `input_schema` / `handler`
- **security metadata**: `surface` (read|mutate|external|transport) / `domain` / `untrustedOutput?`
- **mode / caller**: `callableBy` / `allowedModes`
- **availability**: `isAvailable?` / `availabilityKey?` (OAuth 連携等)
- **confirm**: mutation/外部送信なら `confirmationPolicy` (例: `confirm_external_send`)
- **dedup**: mutation で再実行が害になるなら `dedup` (scope/anchor/title、A9)

### B2. 登録・検索
- **registry**: `src/lib/tools/registry.ts` で import + `ALL_TOOLS` に追加 (route は触らない)
- **例文コーパス** (§12.2): `tool-examples.ts` の `TOOL_EXAMPLES[name]` に発話例 (direct ≥3、紛らわしいもの
  ~10、競合に negative も)
- **tool_index 再 build**: `docker compose exec web npx tsx scripts/build-tool-index.ts`

### B3. specialist 内部ツールか直ツールか
- specialist (schedule/mail 等) 内部から呼ぶツールは runner の tool セットにも含める。dedup は runTool 共通層
  なので両方で効く (A2)。

### B4. 確認・テスト
- `npm run typecheck` / 関連テスト
- mutation: 確認ダイアログ + **dedup が効くか** (同じ依頼2回で2個できないか) を手動確認
- **dedup eval fixture**: textual variant (「岡谷との予定」/「岡谷に行く予定」) を1組テストに追加

### B5. セルフチェック (grep) — **初回実装に含める** (Codex Low)
```bash
# 例文が無いツール
docker compose exec web npx tsx -e 'import {ALL_TOOLS} from "@/lib/tools/registry"; import {TOOL_EXAMPLES} from "@/lib/tools/tool-examples"; const m=ALL_TOOLS.filter(t=>!TOOL_EXAMPLES[t.name]).map(t=>t.name); console.log(m.length?"例文なし: "+m.join(","):"OK")'
# mutation/external なのに dedup が無いツール (再実行ガード漏れ検出)
docker compose exec web npx tsx -e 'import {ALL_TOOLS} from "@/lib/tools/registry"; const m=ALL_TOOLS.filter(t=>(t.surface==="mutate"||t.surface==="external")&&!(t as any).dedup).map(t=>t.name); console.log("dedup 未設定 (要確認): "+m.join(","))'
```

---

## 実装段取り (案)

1. `ToolDef.dedup` フィールド (types.ts)。
2. migration 0073 `tool_execution_log` (status/scope_key/embedding_model 含む) + drizzle schema。
3. dedup ガード本体を **runTool 共通層** + **executePendingTool** に。reservation + advisory lock + status。
4. `skipReason='dedup_recent_execution'` を executor/aggregate に追加し C 報告。
5. 主要 mutation に `dedup` 付与 (gcal_create_event / add_reminder / create_timer / add_todo …、A6 仕様)。
6. 閾値・窓の eval + 調整、textual variant fixture。
7. cleanup job (24h 超削除)。
8. Part B のセルフチェック grep を CI/手順に。
