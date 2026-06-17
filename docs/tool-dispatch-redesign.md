# ツール実行と会話生成の分離 — 設計書

> ステータス: **設計 (v1, 未実装)** — 仕様詰め中。Codex レビュー → 承認 → 実装。
> 関連: [tool-architecture.md](./tool-architecture.md) (ToolDef / registry / specialist / confirm flow)、
> [model-config-overhaul.md](./model-config-overhaul.md) §8.8-8.11 (ローカルモデル実用化)。
> 本書は #206 (モデル設定) とは**独立した機能** = エージェントのツール実行ループそのものの再設計。

---

## 0. 一行サマリ

会話生成モデルに tools を渡すのをやめ、**「会話」「ツール判定/実行」「結果報告」を仕組みで分離**する。
ツール毎の dispatch メタ (投げっぱなしか / どのモデルで処理するか) を読む **Tool Dispatch Controller** を中核に据える。

---

## 1. 背景・問題

### 1.1 症状

ローカル LLM (Qwen3.6-35B) をメインにすると、ツール呼び出しが**本文テキストとして漏れる**:

```
ユーザー: ハルニレテラスにラーメンはないよ。検索してみて
Yui:      ふふっ、お調べしますね。
          [web_search(query="軽井沢 ハルニレテラス ラーメン おすすめ")]   ← テキスト。未実行
```

`tool_use` ブロックとして発行されず、`content` に `[name(args)]` を**書いて終わる** → ツールが実行されない。

### 1.2 根本原因 (実測で確定、2026-06-17)

| 検証 | 結果 |
|---|---|
| Qwen サーバ直叩き (clean prompt + tools) | `tool_calls` 正常 (think on/off 両方) |
| 同上に **Yui システムプロンプトを付与** | `tool_calls` 消滅 → `[web_search(query=...,limit=5)]` テキスト漏れ (引数まで捏造) |
| 汚染履歴 (過去 assistant に `[create_timer(...)]` テキスト) | 漏れが**カスケード**再発 |

→ 引き金は **100% Yui システムプロンプト**。`create_timer(kind="timer", ...)` 等の **`func(args)` テキスト記法の例文 (yui-prompt.ts に多数)** を、非力なモデルが**リテラルに模倣**して本文に書く。強いモデル (Claude) は「説明」と解釈して構造化呼び出しを出すが、**保証はない** (Claude/Gemini も確率的に漏れうる)。

### 1.3 現状アーキの限界

`chat/route.ts` の tool ループは「main が tools 込みで生成 → `tool_use` を拾う → 無ければ promotion で再試行」という**モデルの分離能力に依存**した作り。
- `narrate病 promotion` (行動依頼なのにテキストのみ → directive 注入で再起動、route.ts:840) は漏れへの**その場しのぎの絆創膏**。確率頼みで、ローカルでは破綻。
- 会話プロンプトに**全ツール定義 ~7,000 トークン** (56 tools / 22,052 文字、実測) が常に積載 → プリフィル増・キャッシュ阻害。

### 1.4 方針

**プロンプトで分離を「お願い」するのをやめ、構造で分離を「保証」する。**

---

## 2. 設計原則

1. **会話モデルに tools を渡さない** — 渡さなければ漏れようがない (1.2「sys無し」が証明)。
2. **ツール判定/実行は clean-prompt 専用パスに隔離** — 人格例文ゼロ → 構造化 `tool_calls` が安定。
3. **全モデル適用** — Claude/Gemini も例外にしない (漏れうる + 経路統一)。
4. **投げっぱなしと報告を柔軟に** — ツール毎にフラグ。二重肯定を避ける。
5. **失敗は必ず可視化** — silent ツールでも失敗だけは報告 (黙って失敗させない)。
6. **全ツール実行を Controller に一元化、ただし実装は各ツールファイルへ** — inline / main / specialist / sub-agent の**あらゆる tool use を例外なく Controller の単一関数経由**にする。Controller は横断的関心事 (権限・confirm・untrusted ラップ・ログ・disposition) と振り分けのみを持ち、**ツールの実装ロジックは持たない** (model-less 含め各ツールファイルの handler に閉じる)。役割分離を明確化 → メンテ容易・挙動一貫。

---

## 3. 新ループ

```
ユーザー発話
  │
  ▼[B] Speaker ack   (フル人格, 全履歴, tools 無し)
  │     └ 「2分後に音楽を止めますね」/ 雑談なら即・本応答
  │     └ 全履歴を見て**意図を文脈解決した自然文** = これがツールのトリガー兼種
  │     └ ユーザーへ即時表示 → 以降は裏で進行 (直列だが非ブロッキング)
  │     └ `tool_intent:maybe` なら汎用**「処理中」表示**を出す。集約後に出し分け (§8)
  │
  ▼[A] Executor      (clean prompt + tools, 人格ゼロ。入力 = ユーザー入力 + ack のみ)
  │     └ ack+入力から構造化 tool_calls[] に整形。依存/ID は内部 mini-loop。不要なら空
  │
  ▼  Controller(dispatchTool) が tool_calls を dispatch メタに従い実行
  │     ├ inline      : tool ファイルの handler を直接実行
  │     ├ agent/spec  : 重いモデル sub-agent / specialist に委譲 (難タスク)
  │     └ disposition : silent (報告なし) / report (結果を会話へ)
  ▼ tool 結果 (executionState: executed/pending_confirmation/skipped/failed)
  [C] Speaker報告   (フル人格, tools 無し, + 結果を文脈) ※ report結果/errorReports/confirmReports 時のみ
      └ ローディング解除 → 「検索したら無二ってお店が…」「失敗しました、権限が…」
```

> **直列・非ブロッキング (A 確定)**: データ依存上は B→Executor→実行→C の直列。ただし B の ack を即表示し、report ターンは B→C の隙間に**ローディング表示** (「検索しています…」) を出す = 現状 UX を踏襲。真の並列 (B と判定を同時刻) は採らない (ack を判定入力にするため)。

- **ツール不要ターン**: B が `tool_intent:none` → Executor スキップ (maybe なら起動して即「空」) → B の発話が本応答 (C 無し)。実質 1 パス、軽量。
- **silent のみのターン**: B(ack) → Executor → 実行 で完結 (C 無し)。失敗時のみ C でエラー報告。
- **report ありターン**: B(ack) → Executor → 実行 → C で結果を取り込んだ応答。
- 会話パス (B/C) は**常に tools 無し** → 会話プロンプトから ~7,000 トークン消滅 (プリフィル減・キャッシュ改善)。

### 3.1 ack がトリガーである理由 (= 履歴を持つ独立判定パスを置かない)

ツールの「必要判定」を**メイン Speaker の自然な ack に担わせる** (全履歴を読む独立した判定パスを別に立てない):
- 文脈解決 (「それも」「さっきの」等の参照) は全履歴を持つメインが最も得意。ack に意図が凝縮される。
- Executor は ack+入力という**最小・クリーン入力**だけ → 弱モデルでも構造化が安定、ノイズ誤模倣を防ぐ。
- B は A の結果を知らないが、B 自身が起点なので問題なし。silent は「設定しますね」の楽観 ack で完結 (失敗時のみ C 訂正)、report は軽い ack → C が本応答。

> 体感速度: ユーザーは B の即レスをすぐ受け取る。重い処理 (検索・main executor) は裏で走り C で着地。現状の「ack + SSE で specialist 結果配信」と同じ UX を一般化したもの。

---

## 4. Tool Dispatch Controller (中核)

ツール毎の dispatch メタを読んで、**「どのモデルで処理するか」「結果を会話へ戻すか」**を決めて実行する司令塔。

### 4.0 Controller の入力

Controller が executor へ投げるために必要な情報は 2 階層:

| 階層 | 入力 | 用途 |
|---|---|---|
| **executor 共通** | 直前のユーザー入力 (現在発話) | 「何をしたいか」 |
| | **Speaker の ack 本文** | メインが全履歴を見て**文脈解決済みの意図** (例:「2分後に音楽を止めますね」) |
| **ツール毎** (`ToolDispatch`) | disposition | 報告するか / 投げっぱなしか |
| | executor | どの実行系 (inline / main / specialist) |
| | systemPrompt | その tool の集中プロンプト (executor=main/specialist 時) |

**会話履歴は executor に「生のままでは」渡さない**。最小・クリーン入力で弱モデルの構造化を安定させ、過去話題・別ツール文脈のノイズ誤模倣を防ぐため。ただし **参照解決の穴を塞ぐ規約**を置く (Codex High①/Medium⑤):

- **第一義: ack が解決済み意図を運ぶ**。Speaker B は全履歴を持つので、`「それ検索して」「さっきの無二ってお店も」` のような**会話内参照を ack の中で具体名・条件・否定制約まで解決した自然文**にする (例:「軽井沢の無二ってラーメン屋、調べますね」)。B プロンプトに「ツールが要りそうな依頼は ack で対象・条件を具体化する」を明記。→ executor は ack から復元できる。
- **ID 解決**: 「さっきのリマインダー消して」等の DB ID は executor の **mini-loop (`list_*` → 操作)** で引く。
- **bounded fallback (例外規定)**: ack が曖昧化した / 添付画像内容・直前検索結果への追加操作・ユーザー訂正条件が ack に乗らないケースに備え、executor へ **直近 1-2 ターンの sanitised context summary** (全履歴ではない) を渡せる経路を持つ。既定は ack のみ、必要時のみ bounded summary を付与。
- **untrusted の隔離 (Codex 2巡 High)**: bounded summary は **trusted (会話要約) と untrusted (tool 結果由来要約、web/mail/calendar 等) を分離**して渡す。Executor は tools を持つため C より危険:
  - untrusted 部分は **router system guard 付き**で渡す。
  - **untrusted content 由来の指示で mutation / external-send を起動しない** (= 検索結果に紛れた「〜にメール送れ」等を実行しない)。起動可能なのは trusted (ユーザー発話/ack) 由来の意図のみ。
- **添付・一時情報**: 画像内容やセッション一時情報は ack か bounded summary 経由でのみ executor へ (untrusted 扱い)。

> inline ツールはモデルを使わないので systemPrompt 不要。
> agent/specialist ツールは「そのツール用 systemPrompt + ユーザー入力 + ack」を executor へ渡して実行。

### 4.1 dispatch メタ (ToolDef 拡張)

`tool-architecture.md` の `ToolDef` (v3) に 2 軸を追加:

```ts
type ToolDispatch = {
  // 結果を会話に戻すか
  disposition: "silent" | "report";
  // 判定/実行に使う実行系 (難タスク=重いモデルの sub-agent)。
  // 命名 (Codex Low①): 判定パスの "routerモデル" と紛れないよう、tool 専用 sub-agent は "agent"。
  executor: "inline" | "agent" | { specialist: SpecialistId };
  // executor が agent/specialist の時、その tool 用の集中システムプロンプト。
  // inline (= モデルを使わず関数実行のみ) では不要。
  systemPrompt?: string;
};
```

| 軸 | 値 | 意味 | 例 |
|---|---|---|---|
| disposition | `silent` | B の即レスで完結、C 報告なし (成功時)。失敗のみ報告 | create_timer / add_reminder / delete_todo |
| | `report` | C が結果を取り込み応答 | web_search / list_todos / カレンダー参照 |
| executor | `inline` | ツールファイルの handler を直接呼ぶ (追加モデル無し) | 大半の registry tool |
| | `agent` | 重いモデルの sub-loop で複雑な判定/生成 | レポート生成・予定整理など難タスク |
| | `{specialist}` | 既存 specialist sub-agent に委譲 (独自モデル) | mail / schedule / music / report |

### 4.2 既定値の自動推定 + 明示上書き

- **disposition 既定 (保守側、Codex Medium⑦)**: 名前ベースの単純推定は危険 (`update_*` でも予定更新・連絡先更新・外部送信は確認/報告が要る)。よって:
  - データ返却系 (`search_*` / `list_*` / `get_*` / web_search) = `report`。
  - **外部送信・通知を伴う / confirm 必要 (`confirmationPolicy`) なツールは強制 `report`** (黙って投げっぱなし禁止)。
  - それ以外の純ローカル行動系 (create_timer / add_todo 等) = `silent`。
  - **判断に迷うものは `report` 既定**。silent は「外部影響なし・確認不要」が明示されたものに限る。
- **executor 既定**: `inline`。specialist umbrella tool は `{specialist}`。
- いずれも ToolDef で**明示上書き可能** (「フラグで柔軟に」)。`disposition` は `confirmationPolicy` / external-send フラグと整合させる。

### 4.3 Controller フロー

```
1. Executor pass (clean prompt, 入力 = ユーザー入力 + ack) → tool_calls[]
2. 各 tool_call について dispatch メタを引く
3. executor で実行 (いずれも Controller の単一実行関数 dispatchTool() 経由):
     inline      → tool 関数を直接実行
     agent       → 重いモデルの sub-loop (clean tool prompt, この tool に限定)
     specialist  → specialist sub-agent (background, SSE)
4. executionState × disposition で集約:
     executed  + silent  → 成功は破棄 (B で完結)
     executed  + report  → results[] へ
     failed              → errorReports[] へ (silent でも必ず報告)
     pending_confirmation → confirmReports[] へ (確認待ち通知。完了扱い禁止)
     skipped             → 必要ならログ/軽い報告のみ
5. results / errorReports / confirmReports のいずれかがあれば → Speaker C を起動
```

---

## 5. 各コンポーネント詳細

### 5.1 Executor (ツール整形・実行)

- **入力**: clean system (人格ゼロ、ツール routing ガイダンスのみ) + **ユーザー入力 + Speaker の ack** + tools。**原則 会話履歴は渡さず ack のみ。必要時のみ sanitised bounded summary を追加** (§4.0。untrusted 部は隔離+guard、mutation 起動不可)。
- **出力**: 構造化 `tool_calls[]` のみ (text は無視/破棄、thinking も破棄)。ack に行動意図が無ければ空。
- **依存/ID 解決**: `add_todo → 戻り id → add_reminder(ref_todo_id)`、「さっきの〇〇削除」の ID 引き等は Executor 内の **mini-loop** (tool_result を戻して再判定)。会話とは隔離された純ツールループ。
- **mini-loop の停止性 (仕様必須)**: 無限ループを構造で防ぐ。下記いずれかで**必ず終了**する:
  1. **新規 tool_calls が無くなったら終了** (= 通常の完了)。
  2. **`MAX_TOOL_ITER` 上限** (現状 chat ループの `MAX_ITER=8` 相当) に達したら強制終了。
  3. **進捗なし検知**: mutation/external-send は idempotency ledger (§5.5) で既出なら弾く。read-only は**直前と同一状態での連続反復のみ**を「進捗なし」と見なし弾く (正当な再読込は通す)。反復が続けば終了。
  - 上限/反復で打ち切った場合は**部分結果 + 「全部は完了できなかった」を C に渡す** (黙って成功扱いしない)。
  - これは Executor mini-loop **単体**の上限。階層跨ぎ (Executor→agent→specialist→…) の総量は §5.5 の **global tool budget / depth limit** が別途キャップする (2 段構え)。
- **モデル**: §7。clean prompt なら Qwen で安定 (実測)。サブ(Gemma)候補は要能力検証。
- **routing ガイダンスの移植**: yui-prompt.ts の「アラーム vs リマインダー」「once/habit 判定」「`func(args)` 例」を **Executor プロンプトへ移設**し、**人格プロンプトからは撤去** (= 漏れ源を断つ + 会話プロンプト軽量化)。

### 5.2 Speaker 即レス (B)

- **入力**: フル人格 system (tools 無し) + 履歴 + 現在発話。
- **出力**: ack または雑談本応答。tools が無いので**構造上漏れない**。加えて **`tool_intent: none | maybe` の小さなヒント** (cheap gate 用、§8)。発話テキストとは別フィールドで、構造化ツール呼び出しではないので漏れ源にならない。曖昧時は `maybe` に倒し Executor を必ず起動。
- **ターンの起点**。ユーザーへ即時表示し、ack 確定後に Executor(A) を起動 (= ユーザー体感は並列)。

### 5.3 Speaker 報告 (C)

- **入力**: フル人格 system (tools 無し) + 履歴 + B の発話 + tool 結果 (report) / エラー。
- **出力**: 結果を踏まえた本応答 / 失敗報告 / 確認待ち通知。`executionState=pending_confirmation` の結果は完了扱いしない (§5.5)。
- **起動条件**: report 結果 / errorReports / confirmReports のいずれかがある時のみ (§4.3)。
- **untrusted guard 必須 (Codex High③)**: C は tools を持たないが **tool 結果 (web/search/mail/calendar 等の外部由来) を読む**。現状の guard は「露出ツールに `untrustedOutput` がある時に system へ注入」する実装なので、C で tools を外すと **guard も落ちる**。→ C では **tool 結果ブロック単位で untrusted ラップ + injection guard を必ず注入**する規約を独立させる (tool 露出の有無に依存させない)。dispatchTool が結果に付けた untrusted マーカーを C へ引き継ぐ。

### 5.4 Executor 軸 (specialist の一般化)

既存 specialist (独自モデルの sub-agent + SSE 配信) は **executor の一種**として吸収。
「inline / agent / specialist」は実行の重さの連続体: 引数だけで済む→inline、複雑な単発判定→agent、長い専門ループ→specialist。

### 5.5 dispatchTool() — 単一ディスパッチャ (原則 6)

**役割分離の徹底**: ツールの**実装は各ツールファイルの handler に閉じる** (model-less な単純操作も例外なく自分のファイルを持つ)。**Controller (`dispatchTool`) は実装を一切持たず、分離された構造化ツール呼び出しを元に「適切なツールの handler を呼び出す」だけ**のディスパッチャに徹する。

```
dispatchTool(call, ctx):          // ← ツール実装は書かない。呼び出すだけ
  1. ToolDef 解決 (registry から name で引く) + dispatch メタ (disposition/executor/systemPrompt)
  2. global budget / depth / idempotency チェック (下記)
  3. 権限・availability チェック (registry 駆動)
  4. confirm 必要なら confirm flow へ (tool-architecture §4.5) → executionState=pending_confirmation で即返す
  5. executor に応じて **ツールの handler を呼ぶ**:
       inline      → tool.handler(args, ctx)        ← model-less。実装は tool ファイル側
       agent       → 重いモデルの sub-loop で判定 → tool.handler(...)
       specialist  → specialist sub-agent (内部の tool use も再び dispatchTool 経由)
  6. 結果を untrusted ラップ (tool-architecture §4.6)
  7. turn-local ledger に記録 (§6 重複抑止)
  8. { executionState, disposition, result } を返す
```

- **executionState (Codex High②)**: `disposition` とは独立に実行状態を返す:
  `executed | pending_confirmation | skipped | failed`。
  **`pending_confirmation` を成功として破棄/完了報告してはならない** — 必ず「確認待ち」として扱い、C は完了文を出さない。confirm 必要ツールは silent でも pending を握りつぶさない。
- **再帰の停止性 (Codex High④)**: Executor mini-loop / `executor:agent` sub-loop / specialist / specialist 内 tool use が全て本関数を通るため、個別 `MAX_ITER` では階層跨ぎの二重実行を防げない。**ターン単位の横断ガード**を必須にする:
  - **global tool budget**: 1 ターンで実行できる総ツール呼び出し数の上限。
  - **depth limit**: dispatchTool のネスト深さ上限 (specialist→内部 tool→…)。
  - **idempotency key**: `(name, 正規化 input)` をキーに二重実行を抑止するが、**対象は mutation / external-send のみ** (Codex Medium①)。**read-only ツール (`list_*`/`get_*`/`search_*`) は再実行を許可** — `update → list` の確認読みや mutation 後の再読込を弾かない。read の暴走は「**同一状態での連続反復のみ**」停止 (進捗なし検知)。
- **責務の線引き**:
  - **ツールファイル** = その操作の実装 (model-less 含む。`tool-architecture.md` の domain 別ディレクトリ §4.2)。
  - **Controller** = 横断的関心事 (budget/権限・confirm・untrusted ラップ・ログ・executionState・disposition) + handler への振り分け**のみ**。ロジックを Controller に溜めない。
- **再帰的**: specialist sub-agent が内部でツールを使う時も、その呼び出しは再び `dispatchTool()` を通る (= 全階層で同じガード・ラップ・ログ)。
- **runTool() を吸収**: 現状の `runTool()` は `dispatchTool()` に統合。tool-architecture §2.2/§2.3 の「散在」課題を解消。
- **唯一のチョークポイント**: 全 tool use がこの 1 関数を通る → 抜け道なし、挙動一貫、メンテ容易。

---

## 6. 既存資産の統合・置換

| 現状 | 新設計での扱い |
|---|---|
| `chat/route.ts` の while(MAX_ITER) tool ループ | Executor の mini-loop へ移設 (会話から分離) |
| `narrate病 promotion` (route.ts:840) | **廃止** (Speaker は tools を持たない → 行動漏れが原理的に起きない) |
| specialist dispatch + SSE | `executor:{specialist}` として温存・一般化 |
| `toolSummary` / `[内部実行ログ]` 履歴注入 | **2 層に分離 (Codex Medium⑧)**: ① turn-local execution ledger = Controller が当該ターン内の実行済 (idempotency) を握り二重実行を抑止。② persistent summary = 次ターン用に履歴へ残す「完了済」注入 (Speaker B 側の履歴に効く。Executor は履歴を持たないので ledger で判断)。 |
| confirm 経路 (mutation 確認, tool-architecture §4.5) | 維持。`dispatchTool()` が confirm 必要ツールを従来 flow へ回す |
| `runTool()` (現状の単発実行) | `dispatchTool()` の inline ブランチへ吸収 (§5.5) |
| 散在する権限/untrusted ラップ (tool-architecture §2.2/§2.3) | `dispatchTool()` に集約 (単一ゲートウェイ) |
| 全ツール定義を会話プロンプトに積載 | **撤去** (会話パスは tools 無し) |

---

## 7. 適用範囲とモデル

- **適用**: 全モデル (universal)。hosted (Claude) も会話パスは tools 無し = 漏れ不可。
- **routerモデル** (判定パス = Executor): 既定は **main(Qwen)** (clean prompt で実証済)。
  - サブ(Gemma12b)を routerモデルに使う案は**能力テスト必須** (clean prompt でのツール判定信頼性。M2 の capability probe を流用)。不安なら main にフォールバック。
- **executor:agent** (tool 専用 sub-agent): 「難しいタスクは重いモデル」をツール単位で指定可能に。routerモデルとは別概念 (Codex Low①)。

---

## 8. レイテンシ・トレードオフ

| ターン種別 | パス数 | 体感 |
|---|---|---|
| 雑談 (ツール無し) | B のみ (B が `tool_intent:none` なら Executor スキップ、maybe なら起動して即空) | ほぼ現状、会話プロンプト軽量化で**むしろ速い** |
| silent のみ | B(即表示) → Executor → 実行 | B 即レスで完結、以降は裏で進行 |
| report あり | B(即表示) → Executor → 実行 → C | B 即レス後、**ローディング表示**(「検索しています…」)→ C で着地 (現状 ack+SSE と同等) |

- 会話パスから tools (~7k tok) が消える分、各 Speaker パスは現状より軽い。
- Executor は clean + tools のみで小さい。雑談時は即「空」。
- 正味のコストは「report ターンで Speaker が 2 回」だが、各回が軽量化されるため悪化は限定的。要実測。
- **ローディング表示 (A 確定条件、Codex Medium②)**: ack 直後の時点では Executor 未実行で disposition が未確定 (B は `tool_intent:none|maybe` のみ)。よって:
  - `none` → ローディング無し (雑談)。
  - `maybe` → **汎用「処理中」インジケータ**を出す。Executor 集約後に出し分け:
    - **silent 成功のみ** → 即消す (B の ack で完結)。
    - **report / pending_confirmation / failed** → 継続し、C 着地 (「検索しました…」等) で解除。
  - 現状の loading/SSE pending UX を踏襲。直列でも「放置されている」感を出さない。
- **cheap gate (Codex Medium⑥ → 2巡で保守化)**: 雑談でも Executor を毎回 LLM 起動すると 1 call 増える。ただし**文面ヒューリスティックでのスキップは「ツール必要判定の取りこぼし」を再導入する** (B が「見ておきますね」等の曖昧 ack を返す場合)。よって **skip は B が明示した `tool_intent: none` の時のみ**。`tool_intent` は B が出す小さな enum (`none | maybe`) で、曖昧・maybe なら必ず Executor 起動 (= 安全側)。文面推測でのスキップはしない。補助的に **tool candidate pruning** (ドメイン推定で渡す tools を絞る) で Executor 呼び出し自体を軽くする。

---

## 9. 移行段取り (案)

- **P1**: dispatch メタ (`ToolDispatch`) を ToolDef に追加 + 既定推定。全ツールに付与 (挙動は変えず、メタだけ整備)。
- **P2**: Executor パス (clean prompt + tools, mini-loop) を実装。routing ガイダンスを移植。
- **P3**: Speaker B/C を tools 無しで実装。Controller で **B → Executor → 実行 → C** (直列・非ブロッキング) を配線。`maybe` で「処理中」表示。
- **P4**: narrate病 promotion 撤去、会話プロンプトから tools 定義撤去。
- **P5**: specialist を executor 軸へ吸収。
- 各 P で Codex レビュー + 実機テスト。
- **フラグはリクエスト単位で排他 (Codex Medium⑨)**: 「旧ループ / 新ループ」を 1 リクエストにつき**どちらか一方だけ**が action を拾うよう排他切替。新旧が同一ターンで二重 dispatch しない条件を明記。P3/P4 の「Speaker を tools 無しにした後 promotion/tools 撤去が後回し」になる期間に、新旧両方が action を拾う窓を作らない (Speaker を tools 無しにするのと promotion 撤去・tools 撤去は同一フラグ配下で一斉に切替)。

---

## 10. リスク・未解決

1. **Executor の判定品質**: 人格文脈を切った Executor が、ニュアンス (alarm vs reminder, 暗黙の意図) を正しく拾えるか。routing ガイダンス移植の質に依存。要実機評価。
2. **B の楽観 ack と失敗の齟齬**: silent で B が「設定しました」と言った後に実行失敗 → C で訂正するが、一度肯定した気まずさが残る。ack 文言を「設定しますね」寄りにするか検討。
3. **2 Speaker パスの一貫性**: B と C で口調/内容がズレないよう、C に B の発話を渡す。
4. **レイテンシ実測**: report ターンの 2 Speaker が体感を悪化させないか。
5. **confirm 経路との相互作用**: mutation 確認ツールが Executor/Controller を跨ぐ flow の整合。
6. ~~Executor mini-loop の停止性~~ → **仕様化済み** (§5.1 mini-loop の停止性: `MAX_TOOL_ITER` + 進捗なし検知 + §5.5 global budget/depth の 2 段構え)。無限ループは構造で防ぐ。

---

## 11. テスト

- **A/B 再現**: 汚染履歴 + フル context で、新ループが**テキスト漏れゼロ**になること (本書 1.2 の再現スクリプトを回帰に)。
- **disposition**: silent ツールで二重肯定しない / report ツールで C が結果を反映 / silent 失敗が報告される。
- **executionState (High②)**: confirm 必要ツールが `pending_confirmation` を返し、C が完了文を出さない。pending を成功破棄しない。
- **会話内参照 (High①)**: 「さっきの○○も検索して」で ack が対象を具体化 → Executor が正しい tool_calls を出す。曖昧時 bounded fallback が効く。
- **再帰ガード (High④)**: global budget / depth 上限 / idempotency key で、階層跨ぎ・再試行時の同一 mutation 二重実行が起きない。
- **C の untrusted (High③)**: tools 無しの C でも、外部 tool 結果に injection guard が注入される。
- **依存ツール**: `add_todo → add_reminder(ref_id)` が Executor mini-loop で成立。
- **executor**: inline/agent/specialist が各々正しい実行系に回る。
- **cheap gate (Medium⑥)**: 純雑談で Executor の LLM 呼び出しが増えない。
- **キャッシュ**: 会話パスのプロンプトが tools 撤去で縮小 (~13k) し、プリフィル短縮。
- **手動 (実機)**: 「タイマー」「検索」「予定登録」「雑談」の各経路。routerモデル別 (Qwen/Gemma) の判定精度。
