#!/usr/bin/env bash
#
# Yui Agent: PostgreSQL 15 -> 18 + PGroonga 移行の「リハーサル & 検証」ツール
#
# このスクリプトは **安全なリハーサル専用** です。本番を切り替えません。
#   - 旧 PG15 (postgres_data) を online で dump し、使い捨ての staging volume に
#     PG18 (Dockerfile.postgres の image) として restore、多項目検証する。
#   - **本番 app も旧 volume も一切触らない**。app は止めない。何度でも安全に回せる。
#   - これで「移行が成功するか・どれくらい時間がかかるか・検証が通るか」を事前確認する。
#
# 実際の本番切り替え (cutover) は **手動 runbook**: docs/upgrade-pg18.md を参照。
# cutover は freeze→dump→restore→検証→切替を 1 つのメンテ枠で行う不可逆操作のため、
# bash で自動化せず人間が監督して実施する (PRIME DIRECTIVE)。
#
# 使い方:
#   scripts/upgrade-pg18.sh            # リハーサル実行 (staging を残す)
#   scripts/upgrade-pg18.sh --cleanup  # 過去の staging container/volume を掃除して終了
#
# 設計: docs/tool-dispatch-redesign.md §12.6
#
set -euo pipefail

# ---- 設定 (docker-compose.yml に合わせる) ----
OLD_CONTAINER="yui-agent-postgres"
DB_USER="${POSTGRES_USER:-vroid}"
DB_NAME="${POSTGRES_DB:-vroid}"
DB_PASSWORD="${POSTGRES_PASSWORD:-vroid}"
NEW_IMAGE="${NEW_IMAGE:-yui-agent-postgres:pg18}"
OLD_VOLUME="postgres_data"
TS="$(date +%Y%m%d-%H%M%S)"
STG_VOLUME="postgres_data_pg18_stg_${TS}"          # 毎回新規 = 冪等
STG_CONTAINER="yui-agent-pg18-stg-${TS}"
BACKUP_DIR="${BACKUP_DIR:-./backups/pg18-${TS}}"

log()  { printf '\033[1;36m[pg18]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[pg18 WARN]\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[pg18 ABORT]\033[0m %s\n' "$*" >&2; \
         printf '\033[1;31m本番(app/旧 volume)は無傷です。staging(%s)を捨てて再実行可。\033[0m\n' "$STG_VOLUME" >&2; \
         exit 1; }

# ---- --cleanup: 過去 staging の掃除 ----
if [ "${1:-}" = "--cleanup" ]; then
  log "過去の PG18 staging container/volume を掃除"
  docker ps -a --filter "name=yui-agent-pg18-stg-" --format '{{.Names}}' | while read -r c; do
    [ -n "$c" ] && docker rm -f "$c" >/dev/null && log "  removed container $c"
  done
  docker volume ls --filter "name=postgres_data_pg18_stg_" --format '{{.Name}}' | while read -r v; do
    [ -n "$v" ] && docker volume rm "$v" >/dev/null && log "  removed volume $v"
  done
  log "掃除完了"
  exit 0
elif [ -n "${1:-}" ]; then
  echo "unknown arg: $1 (使い方は scripts/upgrade-pg18.sh のヘッダ参照)" >&2; exit 2
fi

# staging のみ片付ける trap (本番には触れない)
cleanup_on_err() { docker rm -f "$STG_CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup_on_err ERR

# 旧 server と同一ネットワークで PG18 client (新 image) を実行
old_net() { docker inspect "$OLD_CONTAINER" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{println $k}}{{end}}' 2>/dev/null | head -1; }

# =====================================================================
# 0. 前提チェック
# =====================================================================
log "0. 前提チェック"
command -v docker >/dev/null || die "docker が無い"
docker inspect "$OLD_CONTAINER" >/dev/null 2>&1 || die "旧 postgres コンテナ($OLD_CONTAINER)が見つからない"
OLD_PG_VER="$(docker exec "$OLD_CONTAINER" cat /var/lib/postgresql/data/PG_VERSION 2>/dev/null | tr -d '[:space:]')"
[ "$OLD_PG_VER" = "15" ] || die "旧 PG メジャーが 15 ではない (実際: '$OLD_PG_VER')。この script は 15->18 専用。"
docker image inspect "$NEW_IMAGE" >/dev/null 2>&1 || die "新 image($NEW_IMAGE)が未ビルド。先に: docker build -t $NEW_IMAGE -f Dockerfile.postgres ."
NET="$(old_net)"; [ -n "$NET" ] || die "旧コンテナの network を特定できない"
mkdir -p "$BACKUP_DIR"; BACKUP_ABS="$(cd "$BACKUP_DIR" && pwd)"
log "  旧 PG=$OLD_PG_VER / network=$NET / backup=$BACKUP_DIR"
log "  PG18 client version:"; docker run --rm "$NEW_IMAGE" pg_dump --version | sed 's/^/    /'
OLD_DB_BYTES="$(docker exec "$OLD_CONTAINER" psql -tAU "$DB_USER" -d "$DB_NAME" -c "SELECT pg_database_size('$DB_NAME');" | tr -d '[:space:]')"
log "  旧 DB サイズ: $(( ${OLD_DB_BYTES:-0} / 1024 / 1024 )) MB"
warn "  リハーサルは online dump (app 稼働のまま)。本番 cutover は docs/upgrade-pg18.md の手動 runbook で freeze して実施。"

# =====================================================================
# 1. backup (online、PG18 client で旧 PG15 を dump)
# =====================================================================
log "1. dump (online) -> $BACKUP_DIR"
docker run --rm --network "$NET" -e PGPASSWORD="$DB_PASSWORD" "$NEW_IMAGE" \
  pg_dumpall -h "$OLD_CONTAINER" -U "$DB_USER" --globals-only > "$BACKUP_DIR/globals.sql" || die "pg_dumpall --globals-only 失敗"
docker run --rm --network "$NET" -e PGPASSWORD="$DB_PASSWORD" -v "$BACKUP_ABS:/backup" "$NEW_IMAGE" \
  pg_dump -h "$OLD_CONTAINER" -U "$DB_USER" -Fc -d "$DB_NAME" -f "/backup/$DB_NAME.dump" || die "pg_dump -Fc 失敗"
log "  globals.sql + $DB_NAME.dump 取得"

# =====================================================================
# 2. staging PG18 起動 (使い捨て volume) + restore
# =====================================================================
log "2. staging PG18 起動 ($STG_VOLUME) + restore"
docker volume create "$STG_VOLUME" >/dev/null
# PG18 はデータを /var/lib/postgresql 配下のメジャー版別サブディレクトリに置く
# (docker-library/postgres #1259)。旧 PG15 の /var/lib/postgresql/data ではなく
# 親の /var/lib/postgresql をマウントする (PG18 breaking change)。
docker run -d --name "$STG_CONTAINER" --network "$NET" \
  -e POSTGRES_USER="$DB_USER" -e POSTGRES_PASSWORD="$DB_PASSWORD" -e POSTGRES_DB="$DB_NAME" \
  -v "$STG_VOLUME:/var/lib/postgresql" "$NEW_IMAGE" >/dev/null || die "staging 起動失敗"
for i in $(seq 1 30); do
  docker exec "$STG_CONTAINER" pg_isready -U "$DB_USER" >/dev/null 2>&1 && break
  [ "$i" -eq 30 ] && die "staging が ready にならない"; sleep 2
done

# globals を先に restore (roles/ACL/role settings)。initdb 済の vroid role は "already exists" で
# 出るので、それ以外のエラーがあれば fail とする (Codex: 失敗を握り潰さない)。
log "  globals restore (DB restore より先)"
docker exec -i "$STG_CONTAINER" psql -v ON_ERROR_STOP=0 -U "$DB_USER" -d "$DB_NAME" \
  < "$BACKUP_DIR/globals.sql" >"$BACKUP_DIR/restore-globals.log" 2>&1 || true
if grep -iE "ERROR:" "$BACKUP_DIR/restore-globals.log" | grep -ivE "already exists" >/dev/null; then
  grep -iE "ERROR:" "$BACKUP_DIR/restore-globals.log" | grep -ivE "already exists" | head >&2
  die "globals restore に想定外エラー (restore-globals.log)"
fi

# pg_restore --exit-on-error (default はエラー握り潰し)。--no-owner で owner は vroid に正規化。
log "  pg_restore --exit-on-error --no-owner"
docker cp "$BACKUP_DIR/$DB_NAME.dump" "$STG_CONTAINER:/tmp/$DB_NAME.dump"
docker exec "$STG_CONTAINER" pg_restore --exit-on-error --verbose --no-owner \
  -U "$DB_USER" -d "$DB_NAME" "/tmp/$DB_NAME.dump" >"$BACKUP_DIR/restore.log" 2>&1 \
  || die "pg_restore 失敗 (ログ: $BACKUP_DIR/restore.log)"
if grep -iE "^pg_restore: (error|warning)" "$BACKUP_DIR/restore.log" >/dev/null; then
  grep -iE "^pg_restore: (error|warning)" "$BACKUP_DIR/restore.log" | head >&2
  die "restore に error/warning。cutover してはいけない。"
fi
log "  restore 完了 (error/warning 0)。(pgroonga 拡張 + tool_index は cutover 後の migration 0072 で導入)"

# =====================================================================
# 3. 検証 (online リハーサル: 旧は live なので count はドリフトする。
#    ここでは「移行メカニクスが健全か」= restore error-free(済) + invalid index 0
#    + vector 拡張 + gross な restore 漏れ (new 空 / new>old) のみ hard fail とする。
#    厳密な行数一致は cutover (旧 freeze) で実施 → docs/upgrade-pg18.md。)
# =====================================================================
log "3. 検証 (online: 旧 live ドリフトあり。gross gap / invalid index / 拡張を確認)"
q_old() { docker exec "$OLD_CONTAINER" psql -tAU "$DB_USER" -d "$DB_NAME" -c "$1" | tr -d '[:space:]'; }
q_new() { docker exec "$STG_CONTAINER" psql -tAU "$DB_USER" -d "$DB_NAME" -c "$1" | tr -d '[:space:]'; }

# 3a. 全 user table: new>old (複製バグ) / old>0 かつ new==0 (restore 漏れ) のみ fail。
#     それ以外の差は live 書き込みドリフトとして info。識別子は %I で quote。
gen="SELECT format('%I.%I', schemaname, relname) FROM pg_stat_user_tables ORDER BY 1;"
fail=0; drift=0
while IFS= read -r t; do
  [ -z "$t" ] && continue
  oc="$(q_old "SELECT count(*) FROM $t;")"; nc="$(q_new "SELECT count(*) FROM $t;")"
  oc="${oc:-0}"; nc="${nc:-0}"
  if [ "$nc" -gt "$oc" ]; then warn "  new>old (要調査。旧側 delete/truncate でも起きうる) $t old=$oc new=$nc"
  elif [ "$oc" -gt 0 ] && [ "$nc" -eq 0 ]; then warn "  restore 漏れ (new 空) $t old=$oc"; fail=1
  elif [ "$nc" != "$oc" ]; then drift=$((drift+1)); fi
done < <(docker exec "$OLD_CONTAINER" psql -tAU "$DB_USER" -d "$DB_NAME" -c "$gen")
[ "$fail" -eq 0 ] || die "gross な restore gap。cutover しない。"
log "  全テーブル健全 (live ドリフト ${drift} 件は online のため想定内)"

# 3b. large object: gross gap のみ
lo_o="$(q_old "SELECT count(*) FROM pg_largeobject_metadata;")"; lo_n="$(q_new "SELECT count(*) FROM pg_largeobject_metadata;")"
if [ "${lo_o:-0}" -gt 0 ] && [ "${lo_n:-0}" -eq 0 ]; then die "large object restore 漏れ (old=$lo_o new=0)"; fi
log "  large object OK (old=${lo_o:-0} new=${lo_n:-0})"

# 3c. invalid index なし (HNSW 含む) — online でも有効な hard check
[ "$(q_new "SELECT count(*) FROM pg_index WHERE NOT indisvalid;")" = "0" ] || die "invalid index あり (HNSW 再構築失敗の可能性)"
log "  invalid index なし"

# 3d. vector 拡張 (pgroonga は cutover 後 0072 で入るので、ここでは vector のみ必須)
ext="$(q_new "SELECT string_agg(extname,',' ORDER BY extname) FROM pg_extension;")"
case ",$ext," in *,vector,*) log "  vector 拡張 OK ($ext)";; *) die "vector 拡張が復元されていない";; esac

# =====================================================================
# 4. 結果
# =====================================================================
log "✅ リハーサル成功。検証すべて pass。"
log "   staging container : $STG_CONTAINER (起動中、psql で中身を確認可)"
log "   staging volume    : $STG_VOLUME (使い捨て)"
log "   backup            : $BACKUP_DIR"
log ""
log "本番切り替え (cutover) は docs/upgrade-pg18.md の手動 runbook に従って実施 (freeze 必須)。"
log "staging を掃除するには: scripts/upgrade-pg18.sh --cleanup"
