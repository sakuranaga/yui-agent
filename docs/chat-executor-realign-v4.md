# 会話(#1)とツール実行(#2)の再整列 — 設計書 (v4)

> ステータス: **設計 (v4 ドラフト)** — 仕様詰め完了、Codex ゲート前。
> 関連: [tool-dispatch-redesign.md](./tool-dispatch-redesign.md) (v3 = 現行の #1∥#2 並列)、
> [tool-architecture.md](./tool-architecture.md) (ToolDef / specialist / confirm)、
> [tool-dedup-and-adding-tools.md](./tool-dedup-and-adding-tools.md) (重複ガード)。
>
> **v4 改訂 (並列 → 部分逐次の再導入)**: v3 は「#1(発話) ∥ #2(ツール選択) を並列、#2 は #1 を信用せず
> 単独でツール決定」とした。これは **#2 が空振りした時に #1 の楽観発話が宙ぶらりんになる desync** を生む
> (§1)。v4 は **#1 の「ツール選択(pick)」を #2 の leading candidate(再検証付きの第一候補)として渡し、
> `retrieval → #1 → #2` を逐次化**する。
> v3 が否定した「直列」とは別物 — ack を待つのではなく、**高能力モデル #1 の routing 判断を seed に使う**。

---

## 0. 一行サマリ

チャット入力をまず **共有 retrieval(embed+hybrid)** に通して候補ツールを絞り、その top-K を **#1 にも渡す**。
#1 は **即時発話(text) + ツール選択(tool_use=pick)** を 1 レスポンスで返す。#2(Executor)は **#1 の pick を
高確度の第一候補**として受け取り、top-K の中から最終決定して実行する。さらに **action-intent なのに 0 実行で
終わった時は必ず正直に報告する安全網(L2)** を入れ、#1 の「やっておきますね」を宙ぶらりんにしない。

---

## 1. 背景・問題

### 1.1 症状 (2026-06-18, 実機)

「明日の岡谷の予定が重複してるから、一つキャンセルしといて」に対し、Yui は「重複している岡谷の予定、一つ削除して
おきますね」と発話したが **実際には何も削除されなかった**。ログ:

```
[llm:executor] claude-haiku-4-5 ...          ← #2 1回目
[tool-retrieval] no_tool_calls + action-intent → full catalog 再試行
[llm:main] claude-sonnet-4-6 ...             ← #1 が「削除しておきますね」を生成
[llm:executor] claude-haiku-4-5 ...          ← #2 リトライ
[chat] executor: 0 tool(s), stop=no_tool_calls, iters=1   ← dispatched=0
```

### 1.2 根本原因 (2層)

1. **#2 capability gap**: 「重複を一つキャンセル」は `gcal_delete_event`(specialist 専用・`event_id` 必須)を
   単発で呼べない多段タスク。本来 `ask_schedule_specialist`(list→特定→delete を内部ループ)に振るべきだが、
   #2(Haiku)は `ask_schedule_specialist`(常時露出)を持っていたのに **選べず no_tool_calls**。
2. **#1∥#2 desync**: v3 は #1 と #2 を完全並列にし **#2 は #1 を無視**。#1 は捏造禁止ガード(§4.2)に従い
   「削除しておきますね」と **意図のみ** を正しく述べたが、#2 が 0 実行だと **C(結果報告)が起動せず**
   (`needsC = outcomes.length > 0`)、「別途届く」はずの結果が永久に来ない → ユーザーは完了と誤認。

→ #1 は契約を守っている。壊れているのは **(a) #2 が #1 の賢い判断を使えない** ことと
**(b) #2 空振り時の後始末(C)が保証されない** こと。

### 1.3 計測で確定した事実

- **retrieval の遅延は SQL ではなく embedding のネットワーク往復**。warm: embed 40ms / dense SQL 1ms /
  lexical SQL 1ms。cold: embed 99ms。→ 前段直列化のコスト ≒ embed 1 回(~40-100ms)。
- **lexical-only(PGroonga)は精度不足**: 代表 20 クエリで top-10 命中 **lexical 3/20 vs dense 20/20 vs hybrid 20/20**。
  「キャンセル」「次の曲」「変更」等の言い換えを表層一致で拾えない。→ **#1 の pick も embedding が必須**
  (lexical だけで seed すると 15% で有害)。

---

## 2. v3 からの方針転換

| 論点 | v3 (現行) | v4 (本設計) |
|---|---|---|
| #1 と #2 | 完全並列、#2 は #1 を無視 | `retrieval → #1 → #2` 逐次。#2 は #1 の pick を seed |
| #1 の tools | 無し(どんなモデルでも可) | pick 専用疑似ツール `select_tool`(候補=topK∪umbrella を列挙)+ `no_tool`。発話と pick を同時返却 |
| retrieval | #2 ブランチ内(#1 の critical path から隠す) | **共有前段**(embed 1 回、#1/#2 両方が見る) |
| #2 への prior | 無し | **#1 の pick を leading candidate**(強い推奨だが #2 が再検証、raw スコアは渡さない) |
| 空振り時の報告 | C は outcomes>0 のみ | **#2 が 0 実行 && (pickedAction ∨ (pick欠落 ∧ action-intent)) → 必ず C(L2)** |

逐列化のコストは embed ~40-100ms(§1.3)。ユーザー承認済み(~100ms 許容)。

---

## 3. 新フロー

```
チャット入力 (currentUserMsg)
 │
 ├─【前段・共有】 retrieveToolCandidates(query)  ── embed + dense + lexical + RRF
 │     → topK(候補ツール集合)  ※ specialist umbrella は retrieval 非対象で常時同梱
 │
 ├─ #1 (main / Sonnet):  system = persona + slim-guidance(§4.2) + guards
 │     tools = **pick 専用疑似ツール** select_tool(候補=topK∪umbrella を system に列挙) + no_tool
 │     → 返却: text(即時発話) [+ tool_use = select_tool(pick)]   ← 1 レスポンス、実行はしない
 │     → text を即 TTS/SSE 配信(ユーザーはここまで速い)
 │
 ├─ #2 (executor / Haiku 等):  ← #1 完了後に起動(§3.1。#1 が error/timeout ならターン失敗・#2 は走らせない)
 │     tools = **実行ツール** topK ∪ umbrella ∪ {no_tool}
 │     prior = #1 の pick(leading candidate)/ no_tool(hint)
 │     → 再検証込みで最終ツール決定 → dispatchTool / specialist / multi-turn 実行
 │
 └─ C (main): aggregateForReport(outcomes, stopReason)
       needsC または **#2が0実行 && (pickedAction ∨ (pick欠落 ∧ action-intent))** → 結果/失敗を 1〜2 文で正直に報告
```

`#2 は #1 完了後` = #1 の `text + select_tool` を待ってから起動(上限は #1 の既存 LLM コールタイムアウト、§3.1)。「並列」は
**発話を配信しつつ裏で #2 が走る**
体感の意味であって、#1→#2 は逐次。tool_confirm_result mode は従来通り #2 を回さない。

### 3.1 #1 障害時の扱い (Codex High① への回答: フォールバックは作らない)

Codex High① は「#1→#2 逐次は #1 を #2 実行の単一障害点にする」と指摘したが、**意図的にフォールバックを設けない**。
理由: **#1 は発話(ユーザー応答)そのものも生成する**。#1 が error / timeout なら **そもそも返す発話が無く、ターンは
どのみち失敗**している。その状態で #2 だけを prior 無しで裏走りさせると、**発話も報告も無いまま mutation だけが走る**
ことになり、むしろ危険。発話と pick は同じ #1 から出るので**運命を共にするのが正しい**。

- **#2 は #1 の完了(text + pick)を待ってから起動**。別建ての短い deadline は持たない(ローカル LLM #1 は 2〜4s+ が
  普通で、短い deadline は healthy だが遅い #1 を誤って見切り、pick 機能を殺すため)。
- 待ちの上限は **#1 の既存 LLM コールタイムアウト**(モデル毎に設定済み)。#1 が **error / timeout** したら
  **既存のエラー処理でターンを失敗**させ、**#2 は走らせない**(= 何もしない)。これは fail-safe:
  応答も確認も出せない壊れた状態で mutation を実行しない方が安全。
- #1 が正常完了すれば必ず #2 より先なので、**race も順序逆転も発生しない**(旧ドラフトの exactly-once latch /
  遅延 ack 破棄ルールは不要になり削除)。
- **#1 が正常応答だが `select_tool` を出さない / pick 抽出失敗**(error/timeout ではない、Codex High②):
  **prior absent(= #1 から何の信号も無い)**として扱う。**ターン失敗にはせず、#2 を prior 無しで通常起動**
  (#2 が完全に自前判断)。#1 の発話は通常配信。0 実行なら L2(§4.5)が拾う。
  - ⚠️ **明示 `select_no_tool`(§4.2)とは区別する**(Codex Med): 明示 no_tool は「#1 が不要と判断」の **hint** として
    #2 に渡す(#2 を弱く不要方向へ)。一方 **欠落/抽出失敗は hint ですらない prior absent**(#2 へ no_tool hint を
    渡さない)。欠落を no_tool hint 扱いすると #2 を誤って不要方向へ誘導するため。
  - 理由: `tool_choice` で pick を強制すると text(発話)が抑止されるため使えず、欠落は #1 の整形ミス程度のことが多い
    ので、#2 の自前判断に委ねる安全側に倒す。

---

## 4. コンポーネント変更

### 4.1 共有 retrieval 前段 (route.ts)

- 現 `route.ts:925` の `Promise.all([#1, #2])` を解体。retrieval を **#1 起動前**に 1 回実行し、結果(topK)を
  #1・#2 で共有。embed は 1 回だけ(二重 embed しない)。
- retrieval 失敗 / 候補空 / full-catalog mode は **全ツールにフォールバック**(現行の安全側を踏襲)。
- specialist umbrella(`exposedSpecialistTools`)は **retrieval 非対象で常時同梱**(#1・#2 双方に)。
  → 削除/曖昧解消で #1 が `ask_*_specialist` を pick できることを保証。

### 4.2 #1: tools 付与 + pick + slim guidance (C)

- #1 に **pick 専用の疑似ツールを渡す**(現行はゼロ)。**実行可能ツールそのものは渡さない**(Codex Med②: 実行系と
  型/名前を分離し、route 側の誤実行・将来の tool loop 復活事故を構造的に防ぐ)。具体案: 単一メタツール
  `select_tool(tool_name, reason?)`(候補名は system に列挙)、または `pick_<name>` 名前空間。**`pick_*` は実行
  ハンドラを持たない** = 万一 route が拾っても何も起きない。Anthropic は 1 レスポンスで text と tool_use を同時返却可。
  text = 即時発話、tool_use(=select_tool) = pick(#2 への seed、実行しない)。
- **#1 が text 無しで tool_use のみ返した場合**(Codex Med②): 空応答を避けるため**固定 ack**(例:「はい、対応しますね」)
  を補って配信。pick は #2 へ渡す。
- フル `TOOL_USAGE_GUIDANCE`(§v3、`func(args)` 漏れ源)は **#1 に入れない**まま。代わりに **slim guidance** を注入:
  - 「行動依頼なら最も適切なツールを 1 つ pick(複数領域なら複数可)。不要なら `no_tool` を選ぶ。」
  - 「pick は意図の表明であり実行ではない。**発話本文で完了を断言しない**(『削除しました』❌ →『削除しておきますね』✓)。」
  - 「具体的事実(検索結果・予定の有無等)は捏造しない」(既存の捏造禁止ガードは維持)。
- `no_tool` は明示的な sentinel tool(例: `select_no_tool`)。#1 が「何も要らない」を能動的に表明できるようにする。

### 4.3 #1→#2 逐次 + leading candidate (A, Codex High② で調整)

- #2 は #1 の pick 名を取り出し、**第一候補(leading candidate)**として明示注入:
  > 「#1(高能力モデル)が第一候補に選定: `<tool>`。**強い推奨**。ただし最新ユーザー発話・引数 schema 充足・
  > confirmation policy・specialist 適合で**再検証し、満たさなければ覆してよい**(覆した理由はログに残す)。」
- **「採用義務」にはしない**(Codex High②): #1 は履歴/persona/内部ログまで見るのに対し、#2 は
  **最新ユーザー発話のみを mutation 根拠とする trusted 境界**(`executor.ts` の trusted/untrusted 分離)を持つ。
  pick を無条件 trusted 扱いするとこの境界を弱める。よって **prior は「出発点を強く示す」止まりで、#2 の既存
  安全検証(schema/confirmation/最新発話 grounding)は一切迂回しない**。これでも #1 が正しい大半のケースでは
  #2 は素直に pick を採るので、A の意図(#1 判断を高優先)は保たれる。
- **raw retrieval スコアは #2 に渡さない**(未校正・anchor 過多のリスク。recall は候補集合に入れる所まで)。
  ただし「候補に入った根拠(dense/example/floor/specialist)」程度の provenance はログ/入力に載せてよい(Codex Low、任意)。
- #1 が `no_tool` を pick した場合は **hint として渡す**(「#1 は不要と判断、要再確認」)が、**#2 は必ず走る**
  (#1 の no_tool 誤判定を #2 の自前判断で救う = B)。

### 4.4 #2: 候補集合 + EXECUTOR_SYSTEM 改訂

- #2 の tools = **実行ツール** 共有 topK ∪ umbrella ∪ `{no_tool}`。#1 は同じ候補集合を**疑似ツールで pick**するので
  (§4.2)、#1 の pick 先は #2 の実行ツール集合に**必ず含まれる**(名前で対応)。
- **`no_tool` を #2 の明示選択肢に**(実装済 stage3): #2 が「行動不要」を能動的に declension できる。空応答
  (`no_tool_calls`)より信頼でき、**過去履歴の蒸し返し再実行も能動的に断れる**(再実行抑止)。
  - #2 が `no_tool` のみ選択 → `stopReason="declined"`(0 実行で clean stop)。実ツールと混在時は no_tool を捨てて実ツールを処理。
  - `EXECUTOR_SYSTEM`: 「行動不要・既処理・過去履歴の蒸し返しなら no_tool。迷ったら実行より no_tool 優先」。
  - **declined は narrowed→full 再試行をしない**(#2 の decline を full で覆して誤実行/再実行にしない。`no_tool_calls` のみ再試行)。
- `EXECUTOR_SYSTEM` に「leading candidate の扱い」を追記(stage4): **prior があれば再検証(最新発話 grounding / schema 充足 /
  confirmation / specialist 適合)した上で、採用/不採用とその理由をログ**。無条件採用にはしない(§4.3)。
- 既存レバー(single-pass / user-only 履歴 / runtime facts)は維持。

### 4.5 L2 安全網: 行動が期待されたのに 0実行 → 必ず C

`isActionIntent`(regex)単独は **保守的 gate** として広めに作られており(`して`/`教え`/`ほしい` 等を含む)、
**L2 に使うと雑談を誤検知**して「できませんでした」と誤報告する。雑談 vs 行動の分類は **regex ではなく
#1 の pick が高精度にやる**(#1=Sonnet が候補 + `no_tool` から選ぶ)。これが本質的な「雑談フィルタ」。

`exec.outcomes.length === 0` のとき、C を強制起動して正直報告:

- **主信号: `#1 の pick が no_tool 以外を含む`(pickedAction)** — #1 が「行動が要る」と判断したのに 0 実行
  = 最も信頼できる「期待された行動が起きなかった」シグナル。
- **フォールバック: `#1 が pick を1つも出さなかった (pick 欠落) かつ isActionIntent`** — #1 が無応答 pick の
  時だけ regex に頼る(§3.1 の prior absent ケース)。**#1 が明示的に `no_tool` を選んだ時は isActionIntent を
  見ない**(雑談と確定しているので誤報告を避ける)。

→ 実装: `0実行 && (pickedAction ∨ (pick欠落 ∧ isActionIntent))`。
逆に **#1 が `no_tool` を選んだ** = 純粋会話とみなし C 不要(過剰報告防止)。
- **L2 の対象は「#2 を走らせたが 0 実行」のケースのみ**(Codex Med①)。**#1 が error/timeout で #2 をそもそも
  走らせない場合は L2 対象外** — §3.1 通り既存エラー応答でターン失敗とし、mutation はしない(L2 でカバーしようとしない)。
- L1(§4.1-4.4)が効いても **別の capability gap で再発し得る** ため、L2 は独立の下限として必須。
- **eval を追加**(§9): action / 雑談の代表セットで L2 の false positive / false negative を測ってから本番化。

---

## 5. レイテンシ・コスト

- **#1 critical path に embed が乗る**: warm ~40ms / cold ~99ms。keep-alive で cold を warm に寄せる地味改善は別途。
- **action 総レイテンシ**: v3 `max(#1,#2)` → v4 `retrieval + #1 + #2`(逐次)。ただし action 結果は元々別メッセージ(C)
  なので、ユーザー体感は「発話まで速い / 結果は少し後」で UX 退行は小。
- **#1 コスト増**: #1(Sonnet)が tools 定義を入力に持つ → input トークン増。topK(~10-15)+ umbrella の説明文ぶん。
  許容(精度優先の判断)。

---

## 6. 正直性インバリアント

1. **#1 は完了を断言しない**(意図のみ)。完了/結果の言明は **C のみ**が、実 outcomes に基づいて行う。
2. **行動が期待されたターンは必ず C で締める**(成功・失敗・0実行のいずれも)。判定は複合ゲート
   `0実行 && (pickedAction ∨ (pick欠落 ∧ action-intent))`(§4.5)。「別途届く」の約束を破らない。
3. #1 の pick は **seed であって実行確定ではない**。実行可否は #2 が判断。

---

## 7. エッジケース

| ケース | 挙動 |
|---|---|
| #1 が `no_tool` だが実は action | #2 は走る(B)。#2 が拾えば実行、拾えなければ L2 で正直報告 |
| #1 の pick を #2 が実行不能(例: 単発で event_id 無い) | #2 は umbrella(specialist)へ。specialist が内部多段で解決 |
| retrieval 失敗 / embed 障害 | full-catalog フォールバック(候補=全ツール)。#1 の `select_tool` 候補列挙も #2 の実行ツールも全件で継続(精度優先) |
| #1 の pick が候補集合外 | 仕様上ありえない(#1 の tools = 候補集合)。万一は #2 が無視 |
| timer / private mode | timer は #2 allowlist 維持。private は Valkey 履歴を送る(既存挙動踏襲) |
| 複数領域(予定+TODO+メール) | #1 が複数 pick 可。#2 が複数 tool_use を並列実行(既存) |

---

## 8. ロールアウト

- フィーチャフラグ(env or ai_setting)で v3(並列)/ v4(逐次+pick)を切替可能にし、退行時に即戻せるようにする。
- 段階:
  1. ✅ **共有 retrieval 前段化** + #2 互換(retrieval を #1 前に移すだけ、挙動不変)。— commit 8c4e07c
  2+3. ✅ **#1 pick (shadow) + #2 の no_tool + L2 を一体で投入**(当初 stage2 は isActionIntent だけの弱い L2
     を先行する案だったが、その regex は雑談を誤検知するため、**雑談 vs 行動の分類器そのものである #1/#2 の
     `no_tool` pick と同時に**入れた。pick は **#2 の prior には未注入(shadow)**で並列・挙動は据え置き、
     **L2 の主信号としてのみ使う**。#2 の `no_tool`(declined)は再実行抑止にも効く)。
  4. **#2 への prior 有効化**(逐次化 + leading candidate 注入)。shadow データで pick 精度を確認してから。
- フィーチャフラグ(env or ai_setting)で v3 / v4 を切替可能にし退行時に即戻せるように(stage4 で逐次化する際に重要)。
- 各段で Codex レビュー + 実機確認。

---

## 9. 未決の実装詳細(実装時に決定)

- `no_tool` sentinel の表現(`select_tool` の引数で表現 vs 専用 `no_tool` 疑似ツール)。
- `select_tool` 疑似ツールの schema(`tool_name` enum を候補で動的生成するか、自由文字列+検証か)。
- #1 の pick 抽出: text と tool_use 混在レスポンスのパース箇所。
- leading-candidate prior の注入位置(EXECUTOR_SYSTEM 追記 vs user メッセージ前置)。
- **L2 eval セット**(action / 雑談の代表クエリで false positive/negative を測定)。
- フィーチャフラグのキー名。
