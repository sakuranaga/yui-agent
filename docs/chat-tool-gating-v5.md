# Chat Tool Gating v5 — 設計書

> ステータス: **Phase 1 実装済み**
> 関連:
> - [tool-dispatch-redesign.md](./tool-dispatch-redesign.md): v3 = 会話(#1)とExecutor(#2)の並列分離
> - [chat-executor-realign-v4.md](./chat-executor-realign-v4.md): v4 = #1 pick を #2 の seed に使う再整列案
> - [tool-architecture.md](./tool-architecture.md): ToolDef / registry / specialist / confirm
> - [tool-dedup-and-adding-tools.md](./tool-dedup-and-adding-tools.md): 重複実行ガード
>
> **v5 方針**: 即答性より正確性を優先する。ツール結果前の自由発話をやめ、
> **最初に軽量 Tool Gate で `no_tool` / `tool_required` を判定**する。
> `tool_required` の turn では main の自由応答を止め、固定 ack または tool 結果後の本回答だけを出す。

Phase 1 実装範囲:

- `tool_gate` role を LLM registry に追加
- `decideToolGate()` で `no_tool` / `tool_required` を JSON 判定
- `tool_required` 時は main の先行自由発話を止め、Executor を先に実行
- specialist 非同期 job は固定 ack を返し、結果は既存 SSE / voice 経路で後続配信
- Executor が `no_tool` を明示した場合は Gate 偽陽性として通常 main 応答へ復帰

---

## 0. 一行サマリ

チャット入力をまず **Tool Gate** に通し、会話だけで完結するか、ツール結果を待つべきかを決める。

```
入力
  -> Tool Gate (no_tool / tool_required)
      -> no_tool: main が通常応答
      -> tool_required: 固定 ack または短時間待機
            -> Executor が具体ツール選択・実行
            -> 結果を main / specialist voice で回答
```

Tool Gate は **具体ツール名を選ばない**。具体ツール選択は既存の Executor に任せる。

---

## 1. 背景

### 1.1 現行 v3/v4 系の問題

現行系は、即答性を重視して #1(main 発話) と #2(Executor) を並列に近い形で動かす。
そのため、ツールが必要な依頼でも #1 がツール結果前に自然文を生成する。

これは体感速度には有利だが、以下の事故を生む。

- カレンダー取得前に「明日は空です」のような事実誤答をする
- specialist の後続正答と main の先行発話が矛盾する
- 内部ログや toolSummary のような実行補助情報を会話文脈へ混ぜる圧力が出る
- ユーザーには「一度間違えた後に訂正した」体験として残る

秘書AIでは、予定・メール・TODO・連絡先・音楽操作など、**結果の正確性と操作の信頼性が即答性より重要**。

### 1.2 v4 との違い

v4 は #1 に `select_tool` を持たせ、#1 の pick を #2 の leading candidate として使う設計だった。
これは #2 の選択精度改善には有効だが、#1 が同時に自由発話する限り、ツール前誤答の構造リスクが残る。

v5 は役割を分ける。

| 役割 | v4 | v5 |
|---|---|---|
| 最初の判定 | #1 main が発話しながら select_tool | Tool Gate が tool/no_tool だけ判定 |
| main の自由応答 | 常に先に走る | no_tool の時だけ先に走る |
| 具体ツール選択 | #1 pick + #2 再検証 | #2 Executor に一本化 |
| tool_required 時の最初の返答 | main の自由発話 | 固定 ack、または結果まで待つ |

---

## 2. 設計原則

1. **ツールが必要な turn では、ツール結果前に事実回答しない。**
2. **Tool Gate は二値判定を主目的にする。** 具体ツール名は選ばない。
3. **曖昧なら `tool_required` に倒す。** 誤って no_tool にして必要な操作を見逃す方が危険。
4. **no_tool turn は今まで通り自然に速く返す。**
5. **取得系は原則、結果を待ってから本回答する。**
6. **長い処理だけ固定 ack を先に返す。**
7. **mutation / external send は必ず Executor と confirmation / dedup の既存安全網を通す。**

---

## 3. 新フロー

### 3.1 通常 web chat turn

```
currentUserMsg
  |
  |-- Tool Gate LLM
  |     output:
  |       {
  |         decision: "no_tool" | "tool_required",
  |         category: "chat" | "read" | "mutate" | "external" | "transport",
  |         wait_policy: "wait" | "ack_then_wait",
  |         confidence: number
  |       }
  |
  |-- decision=no_tool
  |     -> main LLM 通常応答
  |
  |-- decision=tool_required
        -> wait_policy=ack_then_wait なら固定 ack を返す
        -> tool retrieval
        -> Executor が具体ツール選択・実行
        -> direct tool の report または specialist voice で本回答
```

### 3.2 対象外 turn

以下は v5 gate の初期スコープ外にする。

- `source=cron`
- `source=timer`
- `source=tool_confirm_result`
- periodic worker
- specialist 内部 loop

これらは既に「内部起点」または「確認結果の報告」であり、通常ユーザー発話とは制御条件が違う。

---

## 4. Tool Gate

### 4.1 責務

Tool Gate は「この入力にツール結果が必要か」を決めるだけ。

やること:

- no_tool / tool_required の判定
- 大まかなカテゴリ判定
- 本回答を待つべきか、固定 ack を先に出すべきかの判定
- confidence と短い reason のログ出力

やらないこと:

- 具体ツール名の選択
- tool input の生成
- DB/API の実行
- ユーザー向け自然文の生成
- persona 口調の生成

### 4.2 出力スキーマ

```ts
type ToolGateDecision = {
  decision: "no_tool" | "tool_required";
  category: "chat" | "read" | "mutate" | "external" | "transport";
  wait_policy: "wait" | "ack_then_wait";
  confidence: number; // 0..1
  reason: string;     // debug 用。ユーザーには出さない。
};
```

### 4.3 判定基準

`no_tool`:

- 雑談、感情応答、あいさつ、お礼
- 一般知識で答えられる質問
- アプリ内状態や外部データに依存しない相談
- 明らかに操作・検索・取得・登録が不要な発話

`tool_required`:

- 予定、メール、TODO、連絡先、ノート、日記、健康、音楽再生状態などアプリ内データを読む
- 作成、更新、削除、送信、再生、停止など副作用がある
- 「調べて」「検索して」「確認して」「見て」「登録して」「消して」「送って」
- 現在時刻・天気・外部サービス状態など実データを前提にする
- 文脈上、直前の対象を操作する依頼

曖昧な場合:

- `tool_required` に倒す
- ただし時刻や対象が不足して mutation できない場合も gate は `tool_required`
- 不足確認は main または Executor/C が行う

### 4.4 wait_policy

`wait`:

- 取得系で通常数秒以内に終わる見込み
- 例: 今日/明日の予定、TODO一覧、直近メール数、現在の曲
- 最初の固定 ack を出さず、結果を待って一回で返すことを許可

`ack_then_wait`:

- specialist / web search / mail search など時間がかかる
- mutation や外部操作で、ユーザーに「受け付けた」ことを早く示したい
- 例: 「調べて」「この条件でメール探して」「プレイリスト流して」

初期実装では単純化して、`tool_required` はすべて固定 ack でもよい。
ただし最終形では、短い read は `wait` に寄せる方が自然。

現行実装上の制約:

- `ask_schedule_specialist` / `ask_mail_specialist` など specialist umbrella は `dispatchSpecialistJob`
  で非同期 job 化され、結果は SSE / voice で後続配信される。
- そのため初期実装では、**specialist 経路は常に `ack_then_wait`** とする。
- `wait` は、まず direct tool の report 結果、または将来同期実行に寄せた短い read tool に限定する。
- 予定確認を完全に「待って1回で返す」には、schedule specialist の同期実行化、または短い read 専用 direct path が別途必要。

---

## 5. Executor との関係

Tool Gate は retrieval や Executor を置き換えない。

役割分担:

| 層 | 責務 |
|---|---|
| Tool Gate | ツールが必要か、会話を待たせるか |
| Tool Retrieval | 候補ツールの絞り込み |
| Executor | 具体ツール名と input の決定、mini-loop |
| dispatchTool | 権限、confirm、dedup、budget、実行 |
| specialist | 複雑な領域別調査と voice/report |
| main / voice | ユーザー向け自然文 |

`tool_required` の後は、既存の `retrieveToolCandidates` と `runExecutor` を使う。
v5 では #1 main の `select_tool` shadow pick は不要になる。

移行時は、既存の `select_tool` は以下どちらかにする。

1. 削除する
2. debug shadow として残すが、制御には使わない

推奨は 1。判定責務が Tool Gate と重複するため。

---

## 6. ユーザー応答ポリシー

### 6.1 no_tool

従来通り main が自由応答する。

### 6.2 tool_required + wait

ユーザーには即時 ack を出さず、ツール結果後に本回答を出す。

例:

```
User: 明日の予定教えて
Yui: 明日は終日ピクサー展、13時からBalcony by 6THのご予約です。
```

### 6.3 tool_required + ack_then_wait

固定文のみ先に出す。

例:

```
User: 明日の予定教えて
Yui: 確認しますので、少しお待ちください。
... tool result ...
Yui: 明日は終日ピクサー展、13時からBalcony by 6THのご予約です。
```

固定 ack は LLM で自由生成しない。
domain / category ごとにテンプレート化する。

例:

- schedule/read: `ご予定を確認しますので、少しお待ちください。`
- mail/read: `メールを確認しますので、少しお待ちください。`
- web/external: `お調べしますので、少しお待ちください。`
- mutate: `対応しますので、少しお待ちください。`

---

## 7. 信頼境界

### 7.1 Gate 入力

Tool Gate には、原則として以下だけを渡す。

- 最新ユーザー発話
- 直近の会話履歴の短い trusted 表現
- 現在時刻、source、mode

渡さない:

- 検索結果全文
- メール本文全文
- tool_result 生データ
- memory chunk の長文
- assistant の内部ログ

理由:

Gate は mutation / external send の前段判定なので、外部由来テキストに含まれる命令で `tool_required` を誘発しないようにする。

### 7.2 Executor 入力

Executor は既存方針を維持する。

- mutation / external-send の根拠は最新ユーザー発話
- 履歴や外部由来テキストは文脈参照のみ
- untrusted output は guard / wrapper を維持

---

## 8. モデル設定

Tool Gate は独立した LLM role として設定可能にする。

推奨 role 名:

```ts
"tool_gate"
```

要件:

- 低遅延
- JSON / structured output に強い
- 会話能力は不要
- ツール関数呼び出し能力も不要

フォールバック:

1. `tool_gate` role が設定されていれば使う
2. 無ければ `executor` role
3. それも無ければ `sub`

Gate は失敗時に安全側へ倒す。

- LLM error / parse error: `tool_required`
- timeout: `tool_required`
- confidence が低い: `tool_required`

ただし `tool_required` に倒した結果、Executor が `no_tool` / `declined` / 0実行で終わる場合がある。
この時に何も返さないと、Gate の false positive がそのまま沈黙や不自然な ack になる。

復旧方針:

- `gate=tool_required` かつ Executor が 0実行で `declined`:
  - `category=chat` または Gate confidence 低めなら、**main の通常応答へフォールバック**する。
  - `category=mutate/read/external` なら、**不足確認または「操作を特定できませんでした」系のC応答**を返す。
- `gate=tool_required` かつ Executor が `no_tool_calls`:
  - retrieval narrowing miss の full catalog retry は既存どおり行う。
  - retry 後も0実行なら、gate decision を根拠に C を起動し、未実行を正直に伝える。
- parse error 由来で `tool_required` に倒した場合は false positive が多くなり得るため、
  debug log に `gate_fallback=parse_error` を残す。

つまり、Gate は安全側に倒すが、**Executor が明示的に不要判断した時の main fallback** を必ず持つ。

---

## 9. 実装計画

### Phase 1: Tool Gate 最小実装

- `src/lib/llm.ts`
  - `LlmRole` に `"tool_gate"` を追加
  - `DEFAULT_ROLE_TIER.tool_gate` を追加
  - 推奨初期値は `"tool"`。tool tier 未設定なら既存の `resolveEntry` により sub fallback される
- `src/components/ModelRegistryManager.tsx`
  - `ROLE_META` に `tool_gate` を追加し、UIから role override できるようにする
- `src/lib/tools/gate.ts` を追加
- `ToolGateDecision` 型を定義
- `callLlm("tool_gate", ...)` を使う
- parse error 時は安全側 `tool_required`
- route で通常 web user turn の先頭に gate を挿入

### Phase 2: route の制御変更

- `decision=no_tool`
  - main を通常呼び出し
  - Executor は起動しない
- `decision=tool_required`
  - main の自由発話を起動しない
  - 固定 ack または wait
  - retrieval -> Executor -> C / specialist
- Gate は `envBlock` / `memorySection` / `apiMessages` を組み立てる前に実行する。
  - Gate 入力には最新 user 発話、短い trusted 履歴、現在時刻 / source / mode のみを渡す
  - no_tool の場合だけ、従来どおり main 用の env/memory を構築する
  - tool_required の場合も、Executor / specialist に必要な範囲で envBlock 等を後段構築する

### Phase 3: 既存 select_tool shadow の撤去

- #1 main に `select_tool` を渡す処理を削除
- `pickedAction` 前提の L2 を gate decision ベースに変更
- debug report は gate decision / executor result を表示
- `src/lib/tools/dispatch-prompts.ts` の `SELECT_TOOL_*` は削除するか、移行期間中だけ deprecated 扱いにする

### Phase 4: wait_policy 最適化

- 初期はすべて `ack_then_wait` でもよい
- schedule/read、todo/read、music/status など短い read を `wait` に寄せる
- 閾値を設ける場合は、例えば 1200ms 以内なら ack 無し、超えたら ack をSSEで送る

### Phase 5: 評価とテスト

代表ケース:

- 雑談: `元気?` -> no_tool
- 予定取得: `明日の予定教えて` -> tool_required/read
- TODO追加: `明日10時にゴミ出しリマインダー` -> tool_required/mutate
- 曖昧mutation: `リマインダー入れて` -> tool_required/mutate、Executor側で時刻不足を検出
- 検索: `軽井沢のラーメン調べて` -> tool_required/external
- メール: `未読メールある?` -> tool_required/read
- 音楽: `次の曲` -> tool_required/transport
- お礼: `ありがとう` -> no_tool

---

## 10. 観測性

debug report / logs に以下を出す。

```text
- gate: tool_required category=read wait=ack_then_wait confidence=0.91 reason="予定確認"
- retrieval: hybrid 56->11
- executor: 1 tool(s), stop=single_pass
- final: specialist schedule job=...
```

DB / llm_events では role=`tool_gate` として計測する。

見るべき指標:

- gate latency
- no_tool / tool_required 比率
- tool_required なのに Executor 0実行の率
- no_tool なのにユーザーが再依頼した率
- ツール前誤答の発生数
- 平均初回応答時間
- 平均最終回答時間

---

## 11. リスクと対策

| リスク | 対策 |
|---|---|
| no_tool 誤判定で必要なツールが走らない | 曖昧なら tool_required。代表ケーステストを追加 |
| tool_required が多すぎて会話が遅くなる | Gate prompt を調整。雑談/相談の no_tool 精度を見る |
| ack が毎回出て会話がくどい | read系は `wait` に寄せる。一定時間を超えた時だけ ack |
| Gate LLM の parse error | 安全側 tool_required |
| Executor が 0実行 | gate decision を根拠に Cで正直に報告、不足確認、または main fallback |
| specialist voice がファクトを言い換える | 予定名/メール件名/人名/場所は原文維持ルールを voice/report に追加 |

---

## 12. 非目標

- ToolDef / registry の全面刷新
- specialist pipeline の廃止
- 全ツールの同期化
- memory / profile / environment の再設計
- model registry UI の大幅変更

v5 は turn 制御の変更に集中する。

---

## 13. 採用判断

採用する。

理由:

- 秘書アプリでは即答性より正確性が重要
- ツール結果前の自由発話は、構造的に誤答を生む
- 既存の Executor / dispatchTool / specialist 資産を活かせる
- `tool_gate` role を追加すれば、モデル設定の柔軟性も維持できる

成功条件:

- 予定・メール・TODOなど取得系で、ツール前の事実誤答が出ない
- 雑談の体感速度は維持される
- tool_required turn の初回応答は固定 ack か結果回答だけになる
- debug report で gate -> executor -> result の流れが追える

---

## 14. 自己レビュー結果

現行ソース確認後のレビュー結果。

### 14.1 設計として妥当な点

- `callLlm(role, ...)` と role override 機構が既にあるため、`tool_gate` role の追加は自然。
- `executor` role / tool tier が存在するため、軽量分類用モデルをオプション指定する土台がある。
- `runExecutor` / `dispatchTool` / `retrieveToolCandidates` は再利用でき、v5 は既存資産を壊さず turn 制御だけを変えられる。
- 現行 `route.ts` は main の自由応答と Executor を同時に扱っているため、今回の誤答原因に対し Gate を前段に置くのは有効。

### 14.2 そのまま実装すると危ない点

1. **`tool_gate` role はまだ存在しない。**
   - `src/lib/llm.ts` の `LlmRole` / `DEFAULT_ROLE_TIER`
   - `src/components/ModelRegistryManager.tsx` の `ROLE_META`
   への追加が必須。

2. **specialist は非同期なので、`wait` はすぐには成立しない。**
   - 現行の予定確認は `ask_schedule_specialist` -> `dispatchSpecialistJob` -> SSE/voice。
   - HTTP response 内で結果まで待つ作りではない。
   - 初期実装では specialist は `ack_then_wait` 固定にする。

3. **Gate false positive の復旧が必要。**
   - parse error や低confidenceを `tool_required` に倒す方針は安全だが、Executor が `declined` した時に main を呼ばないと雑談が壊れる。
   - `gate=tool_required` + `executor=declined` の分岐を明示的に持つ。

4. **Gate をどこに挿入するかが重要。**
   - 現行 `route.ts` は env/memory/retrieval を早めに組み立てる。
   - Gate は untrusted 長文を見ない設計なので、`apiMessages` 構築前に置く必要がある。

5. **既存 v4 の `select_tool` と責務が重複する。**
   - 両方を長く残すと、Gate / #1 pick / Executor の三重判定になる。
   - 移行期間を短くし、制御は Gate に一本化する。

### 14.3 実装前に決めること

- `tool_gate` の既定 tier を `tool` にするか `sub` にするか。
  - 本設計では「ツール選択専用モデルを使う」方針に合わせて `tool` を推奨。
  - ただし xLAM 系の function-calling 専用モデルが JSON分類に弱い場合は、role override で sub/local分類モデルへ切り替える。
- 初期の `wait_policy` を本当に使うか。
  - 実装を安全に始めるなら、Phase 1では全 `tool_required` を `ack_then_wait` に固定する。
  - `wait` は Phase 4 で導入する。
- Executor 0実行時の文面。
  - 操作不能 / 情報不足 / no_tool fallback を分けるテンプレートが必要。
