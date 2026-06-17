# PostgreSQL 15 → 18 + PGroonga 移行ガイド

Yui Agent の DB を **PostgreSQL 15.4 (ankane/pgvector:latest) → PostgreSQL 18 + pgvector + PGroonga**
（カスタム image `Dockerfile.postgres`）へ移行する手順。

PGroonga を入れることで、日本語の全文検索（lexical）が正しく動くようになる（`to_tsvector('simple')`
は日本語を語に割れず BM25 が死んでいた。tool_index の日本語 lexical チャネル / 将来の記憶検索改善の土台）。

設計の根拠: `docs/tool-dispatch-redesign.md` §12.6。

---

## ⚠️ これは不可逆操作です（必読）

- **メジャーバージョン移行 (15→18) は data dir 非互換**。PG18 は PG15 のデータディレクトリで起動しない。
  → **logical dump/restore** で新しいボリュームに移す。
- 旧 PG15 ボリューム (`postgres_data`) は **絶対に消さない / 触らない**。これが rollback の生命線。
- **cutover（本番を新 DB に切り替える）前**なら、いつでも旧構成に戻せる（**データ損失なし**）。
- **cutover 後**に新 DB へ書き込みが入ると、それは旧 PG15 には無い。
  → cutover 後の rollback は **データ損失を伴う**（OAuth トークン・会話記憶が絡む）。

## ツールの役割分担

| | 何をするか | 本番への影響 |
|---|---|---|
| **`scripts/upgrade-pg18.sh`**（リハーサル専用） | online dump → 使い捨て staging に restore → 自動検証 | **なし**（app も旧 volume も触らない。何度でも安全に実行可） |
| **本番 cutover**（下記の手動 runbook） | freeze → dump → 新 volume へ restore → migrate → 検証 → 切替 | **あり**（メンテ枠で人間が監督して実施） |

cutover を bash で自動化しないのは意図的。本番データの不可逆操作は、buggy なスクリプトに任せるより
**人間が監督して 1 メンテ枠で実施する方が安全**（PRIME DIRECTIVE）。

---

## 前提

- 現 DB が **PG15**（`docker exec yui-agent-postgres cat /var/lib/postgresql/data/PG_VERSION` が `15`）。
- ディスクに **旧 DB サイズ + α** の空き（dump 用）。
- **PostgreSQL 16 / 17 / 18 の release notes** に目を通す（拡張・認証・設定パラメータ・予約語・planner の breaking changes）。
- 本番移行（cutover）はアプリを止める（write-freeze）。**メンテナンス時間を確保**すること。

> **⚠️ PG18 の破壊的変更（データディレクトリ）**: postgres:18 image は data を
> `/var/lib/postgresql` 配下の版別サブディレクトリ（`/var/lib/postgresql/18/docker`）に置くよう変更された
> （docker-library/postgres #1259）。PG15 の `/var/lib/postgresql/data` を新 PG18 にマウントすると
> 起動を拒否する。**新 PG18 のボリュームは `/var/lib/postgresql`（親）にマウント**すること。
> 旧 PG15 ボリュームは従来通り `/var/lib/postgresql/data` のまま（触らない）。

所要時間の目安: DB サイズ次第。数百 MB なら 10–20 分（dump/restore + HNSW index 再構築 + 検証）。

> **`--no-owner` 方針**: dump/restore は `--no-owner` で行う。**全 object の owner は `vroid` に正規化**され、
> 元 owner/ACL の完全再現はしない（単一ロール構成のため実害なし）。roles/role settings は `globals.sql` で移送する。

---

## 手順（標準 docker compose 構成）

### 0. 新 image をビルド

```bash
docker build -t yui-agent-postgres:pg18 -f Dockerfile.postgres .
```

ビルドログに `postgresql-18-pgdg-pgroonga` と `groonga-tokenizer-mecab` の導入が出ることを確認。

### 1. リハーサル（必須・安全・何度でも）

```bash
scripts/upgrade-pg18.sh
```

これは **本番に一切触れず**に、移行が成功するか・所要時間・検証を事前確認する：

1. 前提チェック（PG15・image・PG18 client version）
2. **online dump**（`pg_dump -Fc` + `pg_dumpall --globals-only`、`./backups/pg18-<ts>/`）
3. 使い捨て staging volume に PG18 起動 → globals 先 restore → `pg_restore --exit-on-error`
4. **自動検証**（online なので旧 live は書き込みでドリフトする前提）:
   **hard check** = restore 漏れ（old>0 かつ new==0）・invalid index（HNSW 含む）・vector 拡張。
   `new>old` と count ドリフトは warning/info（旧側の delete/truncate でも起きうるため）。
   **厳密な行数一致は cutover（旧 freeze）で実施**（手順 3-6）。
5. 成功すると staging container を残す（`docker exec <staging> psql ...` で中身を確認可能）

staging の掃除: `scripts/upgrade-pg18.sh --cleanup`

> リハーサルが通れば、移行メカニクス（image・dump/restore・拡張・HNSW 再構築・所要時間）が
> 確認できる。**通らないうちは cutover しない。** データの厳密一致は cutover 時に旧を freeze して検証。

### 2. 物理バックアップ（cutover 前、停止中スナップショット）

論理 dump に加え、旧ボリュームの**停止中**スナップショットを取る（物理 backup。live tar は信用しない）：

```bash
# compose の named volume の **実体名** を取得する。
# (compose は `postgres_data` を `<project>_postgres_data` という名前で作る。
#  `-v postgres_data:/data` と書くと別の空 volume を新規作成して空 backup になる事故が起きる)
PG15_VOL=$(docker inspect yui-agent-postgres \
  --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}')
test -n "$PG15_VOL" || { echo "PG15 volume が見つからない"; exit 1; }

docker compose stop web discord-bot postgres        # postgres も止めて静止させる
docker run --rm -v "${PG15_VOL}:/data:ro" -v "$PWD/backups":/backup alpine \
  tar czf /backup/postgres_data-pg15.tar.gz -C /data .
docker compose start postgres                        # 次の手順のため postgres だけ戻す
```

### 3. 本番 cutover（手動 runbook、1 メンテ枠で）

> ここからは**書き込みを止めたまま**最後まで進む。途中で app を再開しない（再開すると旧 DB に
> 新たな書き込みが入り、新 DB との差分になる）。

**3-1. write-freeze（app 停止）**

```bash
docker compose stop web discord-bot
```

**3-2. 切替前の検証用に旧の厳密件数を記録**（`n_live_tup` は推定値なので `count(*)` を使う）

```bash
docker compose exec -T postgres psql -qtAU vroid -d vroid > backups/old-counts.txt <<'SQL'
SELECT format('SELECT %L AS t, count(*) AS c FROM %I.%I', relname, schemaname, relname)
FROM pg_stat_user_tables ORDER BY 1
\gexec
SQL
```

**3-3. frozen final dump**（PG18 client で旧 PG15 を）

```bash
NET=$(docker inspect yui-agent-postgres --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}' | head -1)
mkdir -p backups/final
docker run --rm --network "$NET" -e PGPASSWORD=vroid yui-agent-postgres:pg18 \
  pg_dumpall -h yui-agent-postgres -U vroid --globals-only > backups/final/globals.sql
docker run --rm --network "$NET" -e PGPASSWORD=vroid -v "$PWD/backups/final":/backup yui-agent-postgres:pg18 \
  pg_dump -h yui-agent-postgres -U vroid -Fc -d vroid -f /backup/vroid.dump
```

**3-4. compose を新 image + 新 volume に切替**（必ず backup を取ってから）

```bash
# 新 volume が過去の失敗残骸として残っていないか確認 (dirty volume への重ね restore を防ぐ)
PROJECT=$(basename "$PWD")
docker volume inspect "${PROJECT}_postgres_data_pg18" >/dev/null 2>&1 && {
  echo "postgres_data_pg18 が既に存在。中身を確認し、PG18 失敗の残骸なら手動削除してから再実行"; exit 1; }

cp docker-compose.yml docker-compose.yml.pre-pg18.bak
```

`docker-compose.yml` の `postgres` サービスを編集：

```yaml
  postgres:
    # image: ankane/pgvector:latest          # ← 削除
    image: yui-agent-postgres:pg18            # ← ビルド済みの新 image (再ビルドしたいなら build: を使う)
    container_name: yui-agent-postgres
    environment:
      - POSTGRES_USER=vroid
      - POSTGRES_PASSWORD=vroid
      - POSTGRES_DB=vroid
    volumes:
      # ⚠️ PG18 はデータを /var/lib/postgresql 配下の版別サブディレクトリ
      # (/var/lib/postgresql/18/docker) に置く (docker-library/postgres #1259)。
      # PG15 の /var/lib/postgresql/data ではなく **親をマウント** する。
      - postgres_data_pg18:/var/lib/postgresql        # ← 新ボリューム (compose が新規作成)
    # ... ports / healthcheck は据え置き

volumes:
  postgres_data:          # ← 残す（rollback 用、消さない）
  postgres_data_pg18:     # ← 追加
```

`docker compose config -q` で構文を確認してから：

```bash
docker compose config -q && docker compose up -d postgres   # PG18 を空の新 volume で起動
```

**3-5. restore（globals 先 → pg_restore）**

```bash
# globals (ログ保存 + "already exists" 以外の ERROR で中止)
docker compose exec -T postgres psql -v ON_ERROR_STOP=0 -U vroid -d vroid \
  < backups/final/globals.sql > backups/final/restore-globals.log 2>&1
grep -iE 'ERROR:' backups/final/restore-globals.log | grep -ivE 'already exists' \
  && { echo "globals に想定外 ERROR → cutover 中止"; exit 1; }

# 本体 (ログ保存 + error/warning 0 件を確認)
docker cp backups/final/vroid.dump yui-agent-postgres:/tmp/vroid.dump
docker compose exec -T postgres pg_restore --exit-on-error --verbose --no-owner \
  -U vroid -d vroid /tmp/vroid.dump > backups/final/restore.log 2>&1
grep -iE '^pg_restore: (error|warning)' backups/final/restore.log \
  && { echo "restore に error/warning → cutover 中止、3-7 で rollback"; exit 1; }
```

**3-6. migration（pgroonga 拡張 + tool_index）→ 検証 → app 再開**

```bash
docker compose run --rm web npm run db:migrate     # migration 0072 で CREATE EXTENSION pgroonga + tool_index
```

検証：

```bash
docker compose exec -T postgres psql -U vroid -d vroid -c "SELECT extname, extversion FROM pg_extension;"   # vector + pgroonga
docker compose exec -T postgres psql -tAU vroid -d vroid -c "SELECT count(*) FROM pg_index WHERE NOT indisvalid;"  # 0
# 厳密件数を旧 (freeze 済) と比較。3-2 と同じ count(*) で取り diff (一致が期待値)
# 厳密件数を旧 (freeze 済) と比較。一致しなければ restore 漏れ/freeze 失敗 → cutover 中止 (app を再開しない)
docker compose exec -T postgres psql -qtAU vroid -d vroid > backups/new-counts.txt <<'SQL'
SELECT format('SELECT %L AS t, count(*) AS c FROM %I.%I', relname, schemaname, relname)
FROM pg_stat_user_tables ORDER BY 1
\gexec
SQL
diff -u backups/old-counts.txt backups/new-counts.txt || {
  echo "件数差分あり → cutover 中止。restore 漏れまたは freeze 失敗。app を再開しないこと。"; exit 1; }
echo "✅ 全テーブル件数一致"
```

問題なければ app を再開（新 DB で稼働）：

```bash
docker compose up -d
```

**3-7. 動作確認 → 旧ボリュームは数日温存**

記憶検索・チャットが正常なら cutover 完了。**旧ボリューム `postgres_data` と backup は数日温存**してから破棄：

```bash
docker volume rm <project>_postgres_data    # 確信を得てからのみ。数日後の rollback は差分移植なしには不可。
```

---

## ロールバック

| タイミング | 方法 | データ損失 |
|---|---|---|
| **cutover 前** | リハーサル staging を捨てるだけ（`scripts/upgrade-pg18.sh --cleanup`）。本番は元から無傷 | **なし** |
| **cutover 中に restore 失敗** | `cp docker-compose.yml.pre-pg18.bak docker-compose.yml` → `docker compose up -d`（旧 image+旧 volume、データ無傷）→ app 再開 | **なし**（旧 volume 温存ゆえ） |
| **cutover 後** | 可能なら**新 PG18 の emergency dump** を取ってから、compose backup を戻して `docker compose up -d` | **あり**（cutover 後に新 DB へ入った書き込みは失われる） |

---

## トラブルシュート

- **`pg_restore` に error/warning** → cutover 中止、3-7 の rollback。`backups/.../restore.log` を確認。
- **invalid index が残る** → HNSW 再構築失敗。`REINDEX INDEX <name>;` を試す。直らなければ cutover しない。
- **行数/件数不一致** → restore 漏れ。write-freeze できているか確認して dump からやり直す。
- **PGroonga 検索が日本語でヒットしない** → index の tokenizer を確認（`WITH (tokenizer='TokenMecab')`。
  MeCab vs Bigram は recall eval で決定し migration 0072 で固定）。

---

## managed PG / 外部 DB を使っている場合

compose の postgres を使わず外部の managed PostgreSQL（RDS / Cloud SQL 等）を使う場合は script を使わず手動で：

1. **write-freeze**（アプリ停止）。
2. **PG18 client で** `pg_dump -Fc` + `pg_dumpall --globals-only`。
3. **PG18 + pgvector + PGroonga** が使える新インスタンスを用意。
   - managed PG が **PGroonga を提供しないことは多い**。その場合は (a) この image をセルフホスト、または
     (b) 日本語 lexical を諦め dense（pgvector）のみで運用（設計上 dense 単独でも tool 検索は機能する。
     lexical は recall の底上げ）。
4. **globals を先に restore** → `pg_restore --exit-on-error --no-owner`。
5. 上記の**検証**（件数・sequence・invalid index・拡張）→ OK で **cutover**（接続先を新インスタンスへ）。
6. 旧インスタンスは数日温存。
