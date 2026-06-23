# Tool Crash Recovery / Reconciliation

> 作成日: 2026-06-23
> 対象: Tool confirm / dedup / external API side effect
> 関連: `docs/tool-refactor-plan.md` Phase R17

## 1. 結論

現時点では、外部 API をまたぐ mutation の自動 replay / 自動補償は入れない。

理由:
- GCal create / delete は外部 side effect を持つため、プロセス再起動後に「もう一度実行する」方が二重作成・誤削除のリスクが高い。
- `tool_execution_log.status='executing'` は、不確実な状態では実行済み側に倒して dedup window 中の再実行を抑止する方が安全。
- いま必要なのは自動修復よりも、宙に残る状態の検出と、どの窓で何が失われるかの明文化。

したがって当面の方針は以下。

1. pending confirmation は TTL / cleanup で `cancelled` に倒す。
2. executing reservation は retention まで残し、重複 mutation を防ぐ。
3. confirm final / raw message / task output の整合は `npm run eval:tool-db` で検出する。
4. status 分布・latency・confirm state は `npm run observe:tools` で確認する。
5. 実 side effect の自動補償は、外部 API 側の冪等キーまたは照合可能な external id を持てる場合だけ実装する。

## 2. 現状の状態境界

### Confirm A: 確認要求作成

流れ:
- `runTool`
- `dedupCheckAndReserve(..., "pending_confirmation")`
- `requestUserConfirm`
- `setReservationConfirmToken`
- Executor outcome: `pending_confirmation`

クラッシュ窓:
- reservation 作成後、confirm token 紐付け前に落ちる
- Valkey pending 作成後、SSE が届く前に落ちる

現状の扱い:
- Valkey pending は TTL で失効する。
- `tool-exec-cleanup` が古い `pending_confirmation` を `cancelled` に倒す。
- confirm token が無い reservation は user が承認できないため、再依頼で回復する。

### Confirm B: 承認後 handler 実行

流れ:
- `applyConfirmDecision(token, "confirmed")`
- `executePendingTool`
- handler 実行
- `finalizeReservationByToken(token, "executed")`
- `markTaskConfirmFinal`
- `emitConfirmResult`

クラッシュ窓:
- `confirmed` 保存後、handler 前に落ちる
- handler 成功後、reservation finalize 前に落ちる
- reservation finalize 後、task final 前に落ちる
- task final 後、final voice 保存前に落ちる

現状の扱い:
- handler 前に落ちた場合、Valkey に `confirmed` が残っても自動再実行しない。
- handler 成功後に落ちた場合、外部 API side effect は存在しうるが、task final が無い可能性がある。
- `executing` / `pending_confirmation` の残留は `health:tools` / `eval:tool-db` / `observe:tools` で検出する。

## 3. なぜ自動 replay しないか

外部 API mutation は、アプリ DB だけでは「実行されたか」を完全には判定できない。

例:
- GCal create: handler 成功直後に落ちると、Google Calendar には予定があるが、DB の confirm final は無い。
- GCal delete: handler 成功直後に落ちると、Google Calendar からは消えているが、create dedup cancel が未実行かもしれない。

ここで pending / confirmed を見て自動 replay すると、create は二重作成、delete は別対象誤削除につながりうる。
そのため、現時点の自動復旧は「再実行」ではなく「検出」に留める。

## 4. 将来実装する場合の条件

### GCal create

実装条件:
- アプリ側で stable idempotency key を生成する。
- Google Calendar event の `extendedProperties.private` または description に idempotency key を保存する。
- create 前に同 key の event を検索できる。
- handler 成功後に task final 前で落ちても、reconciliation が event を見つけて DB を補完できる。

候補:
- `dedup_anchor + normalized_title + sessionId + confirmToken` を元に idempotency key を作る。
- `extendedProperties.private.yui_idempotency_key` に保存する。

### GCal delete

実装条件:
- delete 対象 event id が task / confirm pending に保存されている。
- delete 後に 404 / notFound を「既に削除済み」として扱える。
- create dedup cancel を後から再実行しても冪等である。

候補:
- delete reconciliation は external API に `get event` して 404 なら success 補完する。
- ただし event id 再利用や calendar id 欠落がないことが前提。

## 5. 現在の運用コマンド

通常の回帰:

```bash
docker compose exec -T web npm run eval:tools
docker compose exec -T web npm run eval:gate-llm
```

DB 健全性:

```bash
docker compose exec -T web npm run health:tools
docker compose exec -T web npm run eval:tool-db
docker compose exec -T web npm run reconcile:tools
docker compose exec -T web npm run eval:tool-reconcile
```

運用観測:

```bash
docker compose exec -T web npm run observe:tools
```

`reconcile:tools` は読み取り専用 dry-run として、古い `pending_confirmation` / `executing` / `running task` /
confirm final と reservation の不整合を検出する。初期実装では外部 API の replay や DB 自動補完は行わない。

`reconcile:tools --fix` は DB 内で安全に閉じるものだけを修復する。
対象は古い `pending_confirmation` の `cancelled` 化と、古い `tasks.status='running'` の `failed` 化に限定する。
古い `executing` reservation、confirm final と reservation の不一致、外部 API の replay / compensate / backfill は自動修復しない。

## 6. 次に実装するなら

優先順位:

1. GCal create に idempotency key を保存する。
2. create reconciliation を読み取り専用 dry-run で作る。
3. dry-run で「補完可能」と判断できるケースだけ DB 補完を実装する。
4. delete は create より後に扱う。誤削除のリスクが高いため、自動 replay は避ける。

今すぐ実装しないもの:
- confirmed pending の自動再実行
- executing reservation の早期 failed 化
- 外部 API 結果不明の mutation を自動成功/失敗に倒す処理
