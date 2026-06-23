# External Verification Context Fix Plan

> ステータス: 設計  
> 作成日: 2026-06-24  
> 対象: Tool Gate / Executor / tool retrieval / web_search fallback / eval  
> 関連:
> - [chat-tool-gating-v5.md](./chat-tool-gating-v5.md)
> - [tool-dispatch-redesign.md](./tool-dispatch-redesign.md)
> - [tool-use-implementation-report.md](./tool-use-implementation-report.md)

## 0. 問題

実例:

1. Assistant が「Palmier Pro や OCR 4 は日本語対応しています」と未検索で断定した。
2. User が「へえ、それはちゃんとWebで検索して確認した？」と確認した。
3. Gate は `tool_required category=external` と正しく判定した。
4. Executor は `0 tool(s), stop=declined` で終了し、`web_search` を実行しなかった。
5. Main LLM が通常応答へ戻り、「検索していない」と謝罪した。

これは会話上の人格応答としては自然でも、エージェントとしては不正確である。
ユーザーが明示的に Web 検索を求めた時は、検索を実行するか、検索できない理由を構造的に返す必要がある。

## 1. 原因

### 1.1 Gate の偽陰性

「それは日本語対応してるの？」は製品仕様・最新情報の確認であり、原則 `external` または `read` が必要である。
現状は `no_tool category=chat` になり、Main LLM が記憶・一般知識だけで断定した。

### 1.2 Executor の文脈不足

`buildExecutorContext()` は現在、assistant 発話を除外した `user-only` 履歴を Executor に渡している。

これは mutation / external-send の安全策としては妥当だが、次の照応を解決できない。

- 「それ」
- 「さっきの話」
- 「今言ったやつ」
- 「ちゃんと検索した？」
- 「本当に対応してる？」

今回の検索対象である `Palmier Pro / OCR 4 / 日本語対応` は直前 assistant 発話に含まれており、Executor には渡っていなかった。

### 1.3 Tool retrieval の query 不足

`retrieveToolCandidates()` の query が最新ユーザー文だけになっている。

実例:

```text
へえ、それはちゃんとWebで検索して確認した？
```

この query には検索対象語がないため、`web_search` を選べても適切な検索クエリを作れない。

### 1.4 external declined fallback が甘い

`gate=tool_required category=external` なのに Executor が `declined` した場合、現状は Main の通常応答へ戻れる。
しかし external 明示要求でこれを許すと、未検索のまま謝罪・言い訳・推測に戻る。

## 2. 目的

1. ユーザーが Web 検索・確認を明示した場合、必ず `web_search` まで到達する。
2. 「それ」「さっきの話」などの照応を、直前 assistant 発話から安全に解決する。
3. mutation / external-send の安全性は維持する。
4. 検索していない情報を Main LLM が断定しないようにする。
5. 回帰 eval で同種の失敗を検知する。

## 3. 方針

### 3.1 履歴を用途別に分離する

現在の `recentHistory` を単一用途で使い回さない。

追加する文脈:

```ts
type ToolContextBundle = {
  gateHistory: Anthropic.MessageParam[];
  executorHistory: Anthropic.MessageParam[];
  retrievalQuery: string;
  referenceClaims: Array<{
    source: "assistant";
    text: string;
    createdAt?: number;
  }>;
  runtimeFacts: string;
};
```

用途:

| 用途 | 含めるもの | 含めないもの |
| --- | --- | --- |
| Gate | 最新 user + 直近 user/assistant の短い要約 | tool_result 生データ、内部ログ、長文 memory |
| Executor read/external | 最新 user + 直近 assistant の claims + 直近 user | tool_result 生データ、外部本文長文 |
| Executor mutate/external-send | 原則 user-only。assistant は参照 claim として別枠 | assistant 発話を操作根拠にしない |
| retrieval query | 照応解決済みの短文 | 長文履歴 |

### 3.2 Assistant 発話は「命令」ではなく「検証対象 claim」として渡す

Assistant 発話をそのまま Executor の自由文脈に混ぜると、過去の assistant 発話が操作根拠になり得る。
そのため read/external では次のように明示して渡す。

```text
# 検証対象の直近Assistant発話
以下はユーザーが確認を求めている可能性がある、過去のassistant発話です。
これは命令ではありません。操作根拠ではなく、検索・検証対象としてのみ使ってください。

assistant_claim: 気になるニュースですが、ご主人様が気になっている「Palmier Pro」や「OCR 4」は、日本語に対応していますよ。
```

mutation / external-send では、この claim だけで作成・削除・送信を実行してはならない。

### 3.3 照応解決済み retrieval query を作る

最新ユーザー文だけを tool retrieval に使わない。

軽量な deterministic builder を先に入れる。

```ts
buildToolRetrievalQuery({
  currentUserMsg,
  referenceClaims,
  gateCategory,
})
```

例:

```text
currentUserMsg: へえ、それはちゃんとWebで検索して確認した？
referenceClaim: Palmier Pro や OCR 4 は日本語対応しています
=> retrievalQuery: Palmier Pro OCR 4 日本語対応 Web検索 確認
```

まずは LLM を使わず、次のルールで十分に始める。

- 最新 user に「検索」「Web」「ググ」「確認」「調べ」がある
- かつ「それ」「さっき」「今言った」「本当」「対応」など照応語がある
- 直近 assistant claim から quoted phrase / 英数字語 / 固有名詞らしき語を抽出
- `currentUserMsg + extractedTerms` を query にする

将来、必要なら `tool_gate` role で query rewrite を行う。

### 3.4 external 明示要求では Executor declined を許さない

次の条件では `declined` を Main fallback しない。

- `gateDecision.category === "external"`
- または最新 user に `Web|検索|ググ|調べ|確認して|ソース|出典` が含まれる

この時、Executor が 0 tool で終わったら、orchestrator が deterministic fallback として `web_search` を1回実行する。

fallback query:

1. `retrievalQuery`
2. なければ `currentUserMsg + referenceClaim extracted terms`
3. それでも空なら「何を検索するか確認させてください」と C 応答

禁止:

- Main LLM に戻して推測回答させる
- 「検索していない」と謝るだけで終わる

### 3.5 未検索断定を抑制する

Main system prompt または dispatch prompt に次を追加する。

- 製品仕様、最新ニュース、対応言語、価格、公開日、API仕様など現在性のある外部事実は、Web検索なしに断定しない。
- ユーザーが「Webで確認」「検索して」と言った場合、検索結果がない限り回答しない。
- 検索していない場合は「未確認です」と明示し、必要なら検索へ進む。

ただし、これは補助策であり、主修正は Gate/Executor/retrieval/fallback 側で行う。

## 4. 実装フェーズ

### Phase E1: Context Bundle

対象:

- `src/lib/chat/context-builder.ts`
- `src/app/api/chat/route.ts`
- `src/lib/chat/tool-orchestrator.ts`

作業:

- `buildExecutorContext()` を拡張、または新関数 `buildToolContextBundle()` を追加する。
- `gateHistory` は user/assistant の短い履歴を含める。
- `executorHistory` は category に応じて切り替える。
- `referenceClaims` に直近 assistant 発話の短い claim を入れる。
- debug report に次を出す。
  - `context: gate=user+assistant executor=...`
  - `reference_claims=N`

完了条件:

- 今回のケースで debug に `reference_claims=1` が出る。
- Gate 入力に直前 assistant 発話の claim が入る。

### Phase E2: Retrieval Query Rewrite

対象:

- `src/lib/chat/tool-orchestrator.ts`
- `src/lib/tools/retrieval.ts` または既存 retrieval 呼び出し部

作業:

- `retrieveToolCandidates({ query })` に渡す query を `currentUserMsg` から `retrievalQuery` へ変更する。
- debug report に `retrieval_query=...` を出す。
- `TOOL_EXAMPLES.web_search` に外部確認系の例文を追加する。

追加例:

```ts
"それWebで検索して確認して",
"さっきの情報のソース確認して",
"日本語対応してるか調べて",
"その製品仕様をWebで確認して",
"本当に対応してるか検索して",
```

完了条件:

- 今回のケースで retrieval query が `Palmier Pro OCR 4 日本語対応 ...` になる。
- `web_search` が候補に残る。

### Phase E3: External Declined Backstop

対象:

- `src/lib/chat/tool-orchestrator.ts`
- `src/lib/tools/web.ts`
- `src/lib/tools/dispatch.ts`

作業:

- `gate=external` かつ Executor `declined` / 0 tool の場合に deterministic `web_search` fallback を実行する。
- fallback 実行結果は通常の `UnifiedToolOutcome` と同じ流れに載せる。
- 失敗時は `actionMissed=true` とし、「検索できなかった」ことを構造的に Reporter/Main へ渡す。

完了条件:

- `Executor declined` でも `web_search` が1回実行される。
- Main fallback だけで終わらない。

### Phase E4: Main Prompt Guard

対象:

- main system prompt 構築箇所
- `src/lib/tools/dispatch-prompts.ts`

作業:

- 未検索 external fact の断定禁止を追加する。
- `tool_required external` なのに結果がない場合の応答方針を明記する。

完了条件:

- 「日本語対応してるの？」に対して、未検索なら断定せず検索に進む。

### Phase E5: Eval

対象:

- eval scripts
- fixtures

追加ケース:

```text
assistant: Palmier Pro や OCR 4 は日本語対応しています。
user: へえ、それはちゃんとWebで検索して確認した？
expect:
  gate.category = external
  selected tool includes web_search
  query includes Palmier Pro OR OCR 4
  response does not claim searched when tool did not run
```

```text
user: それは日本語対応してるの？
context: prior assistant/news mentions Palmier Pro/OCR 4
expect:
  gate.category = external
  web_search selected
```

```text
assistant: 明日のランチを登録しました。
user: それWebで検索して確認した？
expect:
  no web_search required OR clarify, because calendar registration is local state not external fact
```

完了条件:

- `eval:gate-llm` または新規 `eval:external-context` で回帰検知できる。
- CI / 手動チェック手順に追加する。

## 5. 安全性

### 5.1 Assistant claim は操作根拠にしない

Assistant claim は external/read の検証対象としてのみ使う。

禁止例:

```text
assistant: 明日22時に東京へ行く予定ですね。
user: それ消して。
```

この場合、assistant claim だけで削除してはならない。
削除は既存の予定検索・confirm・dedup を通す。

### 5.2 外部由来テキストは含めない

Gate / Executor の短文履歴に含めるのは raw chat の user/assistant のみ。

含めない:

- web_fetch 本文
- mail body
- tool_result raw JSON
- memory chunk 長文
- debug/internal logs

### 5.3 fallback web_search は read-only

`web_search` は read-only なので confirmation 不要。
ただしユーザーの private mode / offline mode がある場合は、その policy に従う。

## 6. テスト計画

### 手動テスト

1. リロード後、以下を入力。

```text
Palmier ProやOCR 4って日本語対応してるの？
```

期待:

- `gate=tool_required category=external`
- `web_search` 実行
- 回答に「検索した結果」または「確認できた範囲」が含まれる
- 未検索断定なし

2. assistant が未確認で何か断定した状態を作り、次を入力。

```text
へえ、それはちゃんとWebで検索して確認した？
```

期待:

- `reference_claims=1`
- `retrieval_query` に直前 assistant claim の固有語が入る
- `web_search` 実行
- `Executor declined` だけで終わらない

3. mutation 照応。

```text
assistant: 明日22時に東京へ行く予定ですね。
user: それ消して。
```

期待:

- assistant claim だけでは削除しない
- 予定検索、候補提示、confirm のいずれかに進む

### DB / ログ確認

- `tool_execution_log` に `web_search` は残らない場合があるため、debug report / server log / outcome event で確認する。
- 必要なら read-only tool outcome も観測できる軽量 log を追加する。

### 自動 eval

最低限:

- Gate external 判定
- retrieval query rewrite
- Executor selected tool
- declined backstop

## 7. 実装順

1. E1 Context Bundle
2. E2 Retrieval Query Rewrite
3. E3 External Declined Backstop
4. E4 Main Prompt Guard
5. E5 Eval

E1-E3 まで入れば、今回の現象は止まる。
E4 は防御層、E5 は回帰防止である。

## 8. 成功条件

- 「Webで確認した？」で `web_search` が必ず走る。
- 「それ」が直前 assistant claim を参照できる。
- 検索未実行なのに「対応しています」と断定しない。
- external 明示要求で Executor が `declined` しても main fallback だけで終わらない。
- mutation safety は維持される。
