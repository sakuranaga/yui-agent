# ツール実行と会話生成の分離 — 設計書

> ステータス: **設計 (v3 確定)** — P1/P2/P3 実装済。#2 入力の trusted/untrusted 分離 + runtime facts は実装側で対応予定 (設計要件)。
> 関連: [tool-architecture.md](./tool-architecture.md) (ToolDef / registry / specialist / confirm flow)、
> [model-config-overhaul.md](./model-config-overhaul.md) §8.8-8.11 (ローカルモデル実用化)。
> 本書は #206 (モデル設定) とは**独立した機能** = エージェントのツール実行ループそのものの再設計。
>
> **v3 改訂 (並列化・ユーザー設計確定)**: v2 は #2(Executor) を #1(B) の ack に依存させ**直列**にしていたが、これは誤り。
> #2 は #1 を信用せず単独でツールを決めるので、#1 を待つ理由がない。正しい設計:
> - **#1(発話) と #2(ツール選択) を並列**に起動 (どちらもチャット入力から)。#2 は #1 の出力(ack)を使わない。
>   → #1 はどんなモデルでも良い (ツール決定に関与しないため)。
> - **#2 には会話履歴を直近 ~3 ターン渡す** (ack ではなく)。参照解決のため
>   (例「明日昼に散歩」→AI→「じゃ予定入れて」の "予定" は履歴がないと不明)。§4.0 の「ack のみ」は撤回。
> - **#2 が単独でツールを決定** → 直ツール=Controller / specialist=既存パイプライン (直列実行)。
> - **#3(C) は報告が要る結果だけ**を会話で返す。
> - **Judge の偽完了誤読は解消** — #2 が #1 の「完了しました」を知らないので誤読のしようがない。ただし `yuiAckText=""` で voice dedup 材料を失う → specialist voice の重複/不整合は別途検証 (§3.1)。
> - **#2 の中身 (ツール選択精度) が肝**。設計レバー (3ターン履歴 / 絞り込み / 文法制約 / description+few-shot) は
>   `executor.ts` 内コメントに記し、運用しながらテストで詰める。モデルは sub(Gemma) が target、当面は要検証。
>
> **v2 のスコープ (以下) は維持**: 会話 main は tools 無し / 直ツールのみ dispatchTool / specialist は既存温存+橋渡し /
> 独自 pipeline 不採用 (orchestration は route 内、既存 emotion/SSE/voice/永続化 素通し) / dispatchTool・runExecutor (P1/P2) 活用。

---

## 0. 一行サマリ

会話生成モデルに tools を渡すのをやめ、**ツールをモデル応答から分離して会話に入れない**。分離したツールは
**単一の Controller (`dispatchTool`) に渡して実行**し、結衣は会話 (ack/報告) だけを喋る。

シンプルな流れ (v3 並列): **#1 発話(tools 無し) ∥ #2 `runExecutor`(ツール選択) → `dispatchTool`/specialist 実行 → 必要時 #3 が報告発話**。
**直ツール (registry) の実行**は Controller に一本化 (権限・confirm・untrusted ラップ・ログ・disposition を集約)。specialist は既存パイプラインへ橋渡し (v2 では Controller を通さない)。

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
6. **直ツール実行を Controller (`dispatchTool`) に一元化** — registry ToolDef の**あらゆる直ツール実行を単一関数経由**にし、横断的関心事 (権限・confirm・untrusted ラップ・ログ・disposition) を集約。Controller は**実装ロジックを持たず**、各ツールファイルの handler を呼ぶだけ (役割分離)。
   - **v2 スコープ**: specialist は既存パイプライン (§5.4) を温存し、Controller には**通さない** (橋渡しのみ)。`dispatchTool` の経路は **direct/inline の 1 段**。
   - **将来 (P5、任意)**: 「全 tool use を Controller 一本化」を完遂 = specialist **内部**の tool 実行も `dispatchTool` 経由に。コア (漏れ対策) には不要なので後回し。

---

## 3. 新ループ (v3: 並列)

```
チャット入力
   ├──→ #1 発話 (main, tools 無し)                  ┐ 並列
   └──→ #2 ツール選択 (直近 ~3 ターン履歴 + tools)    ┘ (#2 は #1 を待たない・信用しない)
                ↓ 直列 (#2 が決定してから実行)
        振り分けて実行:
          ├ 直ツール(registry)  → Controller(dispatchTool) → handler
          └ specialist umbrella → 既存パイプライン (judge / dispatchSpecialistJob / SSE / voice / pendingJobs)
                ↓
        報告が要る結果だけ → #3 報告発話 (main, tools 無し)
```

- **#1 と #2 は並列**。#2 は #1 の出力 (ack) を使わない → #1 はどのモデルでも可 (ツール決定に無関与)。
- **#2 の入力 = 直近 ~3 ターン履歴 + ツール一覧** (ack ではない)。
  参照解決のため (例「明日昼に散歩」→AI→「じゃ予定入れて」の "予定" は履歴がないと不明)。
- **#2 が単独でツール決定**。決定 → 実行は直列。直ツール=Controller、specialist=既存パイプライン温存。
- **#3 (C) は report / 失敗 / pending がある結果だけ**を会話で返す。
- 会話パス (#1 / #3) は**常に tools 無し** → ツール記法のテキスト漏れが構造上ゼロ。

### 3.1 並列にできる理由・#2 が肝

- **#2 は #1 を信用しない** (#1 の ack を入力に使わない) → #1 を待つ意味がない → 並列化。
- **Judge の偽完了誤読は解消** (Codex v3 Medium): #2 は #1 の「完了しました」を知らないので、judge が「もう完了済み」と誤読する材料が存在しない。**ただし** `yuiAckText=""` にすると既存 judge/voice formatter の**重複抑止材料も失う** → specialist 成功後の voice が #1 と重複/不整合になるリスクは残る。**voice dedup は別途検証**。
- **#1 の完了断定を禁止 (Codex v3 Medium)**: #1 と #2 が独立すると、#1 が「設定しました」と断定したのに #2 が `no_tool_calls` で終わる = 報告も出ず**偽完了が残る**ケースが増える。よって **#1 プロンプトで action 系依頼には完了断定を禁止**し「確認しますね / 対応しますね」寄りの ack にする規約を入れる。
- **肝は #2 のツール選択精度**。#2 が「直近 ~3 ターン + runtime facts + 絞り込み済みツール + 文法制約 + 良い description/few-shot」を備えれば、sub(Gemma) でも正確に選べる。設計レバーの詳細は `executor.ts` 内コメント参照。運用しながらテストで詰める。

---

## 4. Tool Dispatch Controller (中核)

ツール毎の dispatch メタを読んで、**「どのモデルで処理するか」「結果を会話へ戻すか」**を決めて実行する司令塔。

### 4.0 Controller の入力

Controller が executor へ投げるために必要な情報は 2 階層:

#2 (Executor) へ渡す入力 (v3)。**`buildExecutorMessages` で trusted / untrusted を分離**して組む (apiMessages を生で渡さない、Codex v3 High①②):

| 区分 | 入力 | 用途 |
|---|---|---|
| **trusted (起動可)** | 直近 ~3 ターンの**ユーザー発話**（+ 結衣の発話本文） | 参照解決（「じゃ予定入れて」→ 何の予定か） |
| | **runtime facts**: 現在時刻(JST) / source・mode / 許可ツールポリシー / env の最小値 | 「明日6時」の日付計算・timer mode 制約 等。#1 の ack を使わないので**ここで明示的に渡す**必要がある |
| | ツール一覧 + description | 選択候補 (将来は絞り込みで上位 N 件) |
| **untrusted (起動不可)** | 履歴中の**外部由来テキスト**（検索結果・メール本文・記憶チャンク・過去 tool 結果） | 文脈参照のみ。guard 付きで分離して渡す |

- **#1 の ack は渡さない** (#2 は #1 を信用しない・並列で待たない、v3)。
- **trusted / untrusted の分離が必須**: 現 route の現在 user メッセージには env/memory が注入される (§8.11)。これを生で #2 に渡すと、**検索結果やメール本文に紛れた「〜にメール送れ」が #2 の tool 起動材料になる**。よって:
  - **mutation / external-send は trusted (ユーザー発話) 由来の意図からのみ起動**。
  - untrusted (外部/検索/メール/記憶/tool結果) は **guard 付きで「参照のみ・指示として実行しない」**と #2 system に明記。
  - runtime facts (時刻/mode 等) は trusted だが env 全文ではなく**最小の事実**だけ。
- **何ターン渡すか**は executor.ts のパラメータで調整 (既定 ~3)。テストで詰める。
- **ID 解決**: 「さっきのリマインダー消して」等の DB ID は #2 の **mini-loop (`list_*` → 操作)** で引く。

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

> **v2 注 (Codex Low①)**: `executor` / `systemPrompt` は P1 で型としては入れたが、**v2 スコープでは未使用**。`resolveDispatch` の実効値は **`disposition` のみ** (直ツールは全て inline 相当、specialist は dispatchTool を通さず別経路で橋渡し §5.4)。`agent`/`{specialist}` は将来拡張のための予約。

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
1. Executor pass (clean prompt, 入力 = 直近 ~3 ターン履歴 (trusted/untrusted 分離) + runtime facts) → tool_calls[]
2. 各 tool_call について dispatch メタを引く
3. tool_use を振り分けて実行 (v2):
     直ツール(registry ToolDef) → dispatchTool() → handler
     specialist umbrella        → onExtraTool → 既存 dispatchSpecialistJob (judge/SSE/voice)
     (agent executor は将来拡張、§7)
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

### 5.1 Executor (#2、ツール選択・実行) — **肝**

> #2 の頭脳 = `executor.ts` (`runExecutor` + `EXECUTOR_SYSTEM`)。設計レバーは executor.ts コメント。

- **入力 (v3)**: clean system (人格ゼロ、routing ガイダンス) + **直近 ~3 ターンの会話履歴** + tools。**#1 の ack は使わない** (並列・#1 を信用しない)。文脈は履歴から #2 自身が取る。
- **出力**: 構造化 `tool_calls[]` のみ (text は無視/破棄、thinking も破棄)。行動不要なら空。
- **並列**: #1(発話) と同時起動。#1 を待たない。
- **依存/ID 解決**: `add_todo → 戻り id → add_reminder(ref_todo_id)`、「さっきの〇〇削除」の ID 引き等は Executor 内の **mini-loop** (tool_result を戻して再判定)。会話とは隔離された純ツールループ。
- **mini-loop の停止性 (仕様必須)**: 無限ループを構造で防ぐ。下記いずれかで**必ず終了**する:
  1. **新規 tool_calls が無くなったら終了** (= 通常の完了)。
  2. **`MAX_TOOL_ITER` 上限** (現状 chat ループの `MAX_ITER=8` 相当) に達したら強制終了。
  3. **進捗なし検知**: mutation/external-send は idempotency ledger (§5.5) で既出なら弾く。read-only は**直前と同一状態での連続反復のみ**を「進捗なし」と見なし弾く (正当な再読込は通す)。反復が続けば終了。
  - 上限/反復で打ち切った場合は**部分結果 + 「全部は完了できなかった」を C に渡す** (黙って成功扱いしない)。
  - これは Executor mini-loop **単体**の上限。階層跨ぎ (Executor→agent→specialist→…) の総量は §5.5 の **global tool budget / depth limit** が別途キャップする (2 段構え)。
- **モデル**: §7。clean prompt なら Qwen で安定 (実測)。サブ(Gemma)候補は要能力検証。
- **routing ガイダンスの移植**: yui-prompt.ts の「アラーム vs リマインダー」「once/habit 判定」「`func(args)` 例」を **Executor プロンプトへ移設**し、**人格プロンプトからは撤去** (= 漏れ源を断つ + 会話プロンプト軽量化)。

### 5.2 Speaker 即レス (B) — **既存 route の main 生成を流用**

> v2: B は新規モジュールではない。**現状 route が tool ループ 1 回目で出している main 生成から `tools` を外しただけ**。

- **入力**: フル人格 system (tools 無し) + 履歴 + 現在発話 (= 現状の systemBlocks/apiMessages から tools を外す)。
- **出力**: ack または雑談本応答。tools が無いので**構造上漏れない**。
- **#2 と並列に起動** (v3。#2 は #1 を待たない・ack を使わない)。ユーザーへは #1 の発話を即時表示。
- **完了断定の禁止** (Codex v3): action 系依頼では「設定しました」と断定せず「確認しますね/対応しますね」寄りに (偽完了防止、§3.1)。
- cheap gate (§8): 既定は常に Executor 起動 (安全側)。`tool_intent:none` の明示スキップは将来の最適化。

### 5.3 Speaker 報告 (C) — **既存 route の「ツール後 main 生成」を流用**

> v2: C も新規モジュールではない。**現状 route がツール実行後に出している完了報告 main 生成から `tools` を外しただけ**。

- **入力**: フル人格 system (tools 無し) + 履歴 + B の発話 + tool 結果 (report) / エラー。
- **出力**: 結果を踏まえた本応答 / 失敗報告 / 確認待ち通知。`executionState=pending_confirmation` の結果は完了扱いしない (§5.5)。
- **起動条件**: report 結果 / errorReports / confirmReports / 打ち切り通知のいずれかがある時のみ (§4.3)。
- **untrusted guard 必須 (Codex High③)**: C は tools を持たないが **tool 結果 (web/search/mail/calendar 等の外部由来) を読む**。現状の guard は「露出ツールに `untrustedOutput` がある時に system へ注入」する実装なので、C で tools を外すと **guard も落ちる**。→ C では **tool 結果ブロック単位で untrusted ラップ + injection guard を必ず注入**する規約を独立させる (tool 露出の有無に依存させない)。dispatchTool が結果に付けた untrusted マーカーを C へ引き継ぐ。

### 5.4 specialist の扱い — **既存パイプライン温存 (v2 改訂: 吸収しない)**

> v1 は specialist を「executor の一種として吸収」する設計だったが撤回。**specialist は既存の `dispatchSpecialistJob` パイプライン (独自モデル sub-agent + judge + SSE 配信 + voice 整形 + pendingJobs) をそのまま温存**する。

- **会話 main は tools を持たない**ので、specialist 呼び出しの**判定も Executor が行う** (specialist umbrella tool を Executor の tool 一覧に含める)。
- Executor が specialist umbrella tool を呼んだら、**dispatchTool ではなく既存の specialist 経路へ橋渡し**する (route が提供するコールバック → 既存 `dispatchSpecialistJob` + judge)。書き換えない。
- 直ツール (registry ToolDef) のみ dispatchTool (inline) で実行。
- → dispatchTool の責務は **直ツール (inline) 実行に限定**。`executor: agent/{specialist}` の軸は本スコープでは**使わない** (将来拡張、§7)。`ToolDispatch` の実効コアは `disposition` のみ。

#### 5.4.1 橋渡し API (P3 実装境界、Codex v2 High①)

`runExecutor` は現状 direct `ToolDef[]` 前提。specialist umbrella を扱うため**小さな bridge を追加**する:

- Executor に渡す tool カタログ = **direct `ToolDef[]` + specialist umbrella (`Anthropic.Tool[]`) の union**。
- runExecutor を拡張: `extraTools?: Anthropic.Tool[]` (Executor の tool 一覧に追加) + `onExtraTool?: (toolUse) => Promise<ExecutorOutcome 相当>` (specialist tool_use のハンドラ)。
- mini-loop は tool_use ごとに分岐: registry ToolDef → `dispatchTool`、specialist umbrella → `onExtraTool`、どちらでもない → unknown/failed。
- route が `onExtraTool` を実装し、内部で既存 judge + `dispatchSpecialistJob` を呼ぶ。

#### 5.4.2 specialist 成果の集約規約 (二重応答防止、Codex v2 High②)

specialist は**非同期** (dispatchSpecialistJob → pendingJobs → 後で SSE/voice で本返答) なので、C を二重に走らせない:

| 状況 | executionState | disposition | C/後続 |
|---|---|---|---|
| dispatch 成功 (job 投入) | `executed` | **`silent`** | C 起動しない。pendingJob 追加 → 結果は**既存 SSE/voice 経路**で配信 |
| judge skip (env で答え切れる) | `skipped` | — | **責務分離 (Codex v3)**: judge は skip を返すだけ (#1 の ack は見ない、`yuiAckText=""`)。**集約時に #1 の発話を見て**判断 — #1 が実質回答済みなら C 無し、未回答 (「確認しますね」程度) なら C を起動して回答する。「黙って答えない」を作らない |
| dispatch 失敗 | `failed` | report | C で失敗報告 |

→ specialist 成功は **silent 固定** (Executor 側で report として C を呼ばない)。本返答は従来通り SSE/voice。

### 5.5 dispatchTool() — 単一ディスパッチャ (原則 6)

**役割分離の徹底**: ツールの**実装は各ツールファイルの handler に閉じる** (model-less な単純操作も例外なく自分のファイルを持つ)。**Controller (`dispatchTool`) は実装を一切持たず、分離された構造化ツール呼び出しを元に「適切なツールの handler を呼び出す」だけ**のディスパッチャに徹する。

```
dispatchTool(call, ctx):          // ← ツール実装は書かない。呼び出すだけ
  1. ToolDef 解決 (registry から name で引く) + dispatch メタ (disposition/executor/systemPrompt)
  2. global budget / depth / idempotency チェック (下記)
  3. 権限・availability チェック (registry 駆動)
  4. confirm 必要なら confirm flow へ (tool-architecture §4.5) → executionState=pending_confirmation で即返す
  5. **ツールの handler を呼ぶ** (v2: 直ツールは全て inline):
       inline      → tool.handler(args, ctx)        ← model-less。実装は tool ファイル側
       (agent / specialist executor は v2 スコープ外 = 将来拡張。§7)
  6. 結果を untrusted ラップ (tool-architecture §4.6)
  7. turn-local ledger に記録 (§6 重複抑止)
  8. { executionState, disposition, result } を返す
```

- **executionState (Codex High②)**: `disposition` とは独立に実行状態を返す:
  `executed | pending_confirmation | skipped | failed`。
  **`pending_confirmation` を成功として破棄/完了報告してはならない** — 必ず「確認待ち」として扱い、C は完了文を出さない。confirm 必要ツールは silent でも pending を握りつぶさない。
- **再帰の停止性 (Codex High④)**: Executor mini-loop は本関数を通る。将来 (P5) specialist 内 tool use や agent sub-loop も通すと階層が深くなるため、個別 `MAX_TOOL_ITER` では階層跨ぎの二重実行を防げない。**ターン単位の横断ガード**を最初から備える (v2 コアでは Executor→dispatchTool の 1 段だが、ガードは将来の多段に耐える設計):
  - **global tool budget**: 1 ターンで実行できる総ツール呼び出し数の上限。
  - **depth limit**: dispatchTool のネスト深さ上限 (specialist→内部 tool→…)。
  - **idempotency key**: `(name, 正規化 input)` をキーに二重実行を抑止するが、**対象は mutation / external-send のみ** (Codex Medium①)。**read-only ツール (`list_*`/`get_*`/`search_*`) は再実行を許可** — `update → list` の確認読みや mutation 後の再読込を弾かない。read の暴走は「**同一状態での連続反復のみ**」停止 (進捗なし検知)。
- **責務の線引き**:
  - **ツールファイル** = その操作の実装 (model-less 含む。`tool-architecture.md` の domain 別ディレクトリ §4.2)。
  - **Controller** = 横断的関心事 (budget/権限・confirm・untrusted ラップ・ログ・executionState・disposition) + handler への振り分け**のみ**。ロジックを Controller に溜めない。
- **再帰的 (将来 P5)**: specialist sub-agent 内部の tool use も `dispatchTool()` を通すと全階層で同じガード・ラップ・ログになる。**v2 では未実施** (specialist は既存パイプライン温存)。budget/depth ガードは将来の多段に備えて最初から入れておく。
- **runTool() を吸収**: 現状の `runTool()` は `dispatchTool()` に統合。tool-architecture §2.2/§2.3 の「散在」課題を解消。
- **直ツールの唯一のチョークポイント**: registry 直ツールの実行はこの 1 関数を通る → 抜け道なし、挙動一貫、メンテ容易。(specialist は別経路 §5.4、将来 P5 で統合可)

---

## 6. 既存資産の統合・置換

| 現状 | 新設計での扱い (v2) |
|---|---|
| `chat/route.ts` の while(MAX_ITER) tool ループ (main が tools 込みで tool_use 発行) | main から tools を外し、**tool 判定を Executor mini-loop に移設**。tool 実行ボディ (registry/specialist 分岐) は流用 |
| `narrate病 promotion` (route.ts:840) | **廃止** (会話 main は tools を持たない → 行動漏れが原理的に起きない) |
| specialist dispatch + SSE + judge + voice + pendingJobs | **既存パイプラインを温存** (§5.4)。Executor が specialist 呼び出しを決定 → 既存 `dispatchSpecialistJob` 経路へ橋渡し (吸収・書き換えしない) |
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
- **executor:agent / {specialist}** (tool 専用 sub-agent): **v2 では本スコープ外 (将来拡張)**。直ツールは全て inline、specialist は既存パイプライン橋渡し (§5.4)。「難しいタスクは重いモデル」をツール単位で指定する agent 軸は、必要になったら追加する。`ToolDispatch.executor`/`systemPrompt` フィールドは P1 で型としては入れたが、当面の実効コアは `disposition` のみ。

---

## 8. レイテンシ・トレードオフ

| ターン種別 | パス数 | 体感 |
|---|---|---|
| 雑談 (ツール無し) | B ∥ Executor (並列)、ツール不要なら Executor 即「空」 | ほぼ現状、会話プロンプト軽量化で**むしろ速い**。将来 cheap gate で Executor 1 call 省略可 |
| silent のみ | B ∥ Executor → 実行 | B 即表示で完結、以降は裏で進行 |
| report あり | B ∥ Executor → 実行 → C | B 即表示後、**ローディング表示**(「検索しています…」)→ C で着地 (現状 ack+SSE と同等) |

- 会話パスから tools (~7k tok) が消える分、各 Speaker パスは現状より軽い。
- Executor は clean + tools のみで小さい。雑談時は即「空」。
- 正味のコストは「report ターンで Speaker が 2 回」だが、各回が軽量化されるため悪化は限定的。要実測。
- **ローディング表示 (v2)**: B の ack を即表示し、**Executor が走る間は汎用「処理中」インジケータ**を出す。Executor 集約後に出し分け:
  - **silent 成功のみ / ツール無し** → 即消す (B の ack で完結)。
  - **report / pending_confirmation / failed / 打ち切り** → 継続し、C 着地 (「検索しました…」等) で解除。
  - 現状の loading/SSE pending UX を踏襲。直列でも「放置されている」感を出さない。
- **cheap gate (将来最適化)**: v2 P3 は **Executor を常時起動** (安全側 = 取りこぼさない)。雑談でも 1 call 増えるコストはあるが、会話プロンプト軽量化で相殺。将来、B が `tool_intent` のような明示 hint を出せるようになったら「none の時だけ Executor スキップ」を足す (文面ヒューリスティックでのスキップは取りこぼすので不可)。補助的に tool candidate pruning も可。**v2 では実装しない**。

---

## 9. 移行段取り (案)

- **P1 (済)**: dispatch メタ (`ToolDispatch`) を ToolDef に追加 + 既定推定。挙動不変。
- **P2 (済)**: `dispatchTool` 単一ゲートウェイ (P2a) + `runExecutor` mini-loop (P2b)。挙動不変。
- **P3 (次)**: **route 配線**。chat/route.ts のループで:
  - 会話 main (B/C) から **`tools` を外す** (= 漏れない)。
  - **#1(main 発話) と #2(`runExecutor`) を並列起動** (Promise.all)。#2 は直近3ターン履歴で tool 判定→ `dispatchTool` 実行 (直ツール)。
  - specialist umbrella tool は **既存 `dispatchSpecialistJob` 経路へ橋渡し** (judge/SSE/voice/pendingJobs 温存)。
  - tool 結果を踏まえ main で報告 (C)。emotion/永続化/SSE は既存処理を素通し。
  - `narrate病 promotion` は廃止 (会話 main が tools を持たない)。
  - **独自 pipeline モジュールは作らない** (orchestration は route 内)。
- **P4**: routing ガイダンスを Executor プロンプトへ移植し、**人格プロンプトから tools 定義・guidance を撤去** (会話プロンプト軽量化)。
- **P5 (任意・将来)**: 「全 tool use を Controller 一本化」の完遂 = specialist **内部**の tool 実行も `dispatchTool` 経由に (specialist の dispatch/SSE/voice パイプライン自体は温存のまま、内部の runTool を dispatchTool へ)。コア (漏れ対策) には必須でないため後回し可。
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
- **会話内参照 (v3)**: 直近 ~3 ターン履歴で「じゃ予定入れて」「さっきの○○削除」の参照を #2 が解決 → 正しい tool_calls を出す (ack は使わない)。trusted/untrusted 分離で外部由来テキストから mutation を起動しないことも確認。
- **再帰ガード (High④)**: global budget / depth 上限 / idempotency key で、階層跨ぎ・再試行時の同一 mutation 二重実行が起きない。
- **C の untrusted (High③)**: tools 無しの C でも、外部 tool 結果に injection guard が注入される。
- **依存ツール**: `add_todo → add_reminder(ref_id)` が Executor mini-loop で成立。
- **直ツール / specialist 橋渡し**: registry 直ツールは dispatchTool (inline) へ、specialist umbrella tool は `onExtraTool` → 既存 `dispatchSpecialistJob` へ正しく振り分く。specialist 成功は silent (C 二重起動なし)、dispatch 失敗は C で報告 (§5.4.2)。
- **judge skip の分岐 (§5.4.2)**: judge skip かつ B ack が実質回答済み → C 起動せず ack 完結。judge skip だが ack 未回答 (「確認しますね」等) → C が回答する (黙って答えないを作らない)。
- **雑談 (v2 常時起動)**: 純雑談では Executor が空 (tool_calls 無し) を返し、C が起動せず B の発話が本応答。
- **キャッシュ**: 会話パスのプロンプトが tools 撤去で縮小 (~13k) し、プリフィル短縮。
- **手動 (実機)**: 「タイマー」「検索」「予定登録」「雑談」の各経路。routerモデル別 (Qwen/Gemma) の判定精度。
