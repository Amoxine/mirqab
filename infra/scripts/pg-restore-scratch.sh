#!/usr/bin/env bash
# Restore a Postgres base backup to a SCRATCH instance and verify it by row count (WP29a).
#
# This exists as a script rather than a documented procedure for one reason: it is the only
# operation in this repository where a typo destroys data that cannot be recovered. A runbook
# cannot refuse a bad volume name at 3am; this can, and does, before it creates anything.
#
#   infra/scripts/pg-restore-scratch.sh                      # latest backup -> scratch, verify, destroy
#   infra/scripts/pg-restore-scratch.sh --backup 20260924T172613Z
#   infra/scripts/pg-restore-scratch.sh --keep               # leave the scratch instance running
#   infra/scripts/pg-restore-scratch.sh --list                # just show available backups
#
# What it will NOT do, by construction:
#   - write to, mount, or even name the primary's data volume (refused before any docker action)
#   - reuse an existing volume (a half-restored cluster on top of someone else's data is worse
#     than no restore at all)
#   - leave archive_mode on in the scratch instance — it would inherit the primary's
#     archive_command, have no /wal_archive to write to, jam its own pg_wal, and if it DID get
#     that volume would write the restored cluster's segments over the primary's archive
set -Eeuo pipefail

PRIMARY_CONTAINER="${PRIMARY_CONTAINER:-open-gateway-postgres}"
BACKUP_VOLUME="${BACKUP_VOLUME:-}"
SCRATCH_VOLUME="${SCRATCH_VOLUME:-pg-restore-scratch}"
SCRATCH_CONTAINER="${SCRATCH_CONTAINER:-pg-restore-scratch}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
BACKUP=""
KEEP=false
LIST=false

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "[restore] $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="${2:-}"; shift 2 ;;
    --volume) SCRATCH_VOLUME="${2:-}"; shift 2 ;;
    --container) SCRATCH_CONTAINER="${2:-}"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --list) LIST=true; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

command -v docker >/dev/null || die "docker not found"

if [ -z "$BACKUP_VOLUME" ]; then
  BACKUP_VOLUME="$(docker inspect open-gateway-postgres-backup \
    --format '{{range .Mounts}}{{if eq .Destination "/backups"}}{{.Name}}{{end}}{{end}}' 2>/dev/null || true)"
fi
[ -n "$BACKUP_VOLUME" ] || die "could not determine the backups volume; pass BACKUP_VOLUME=<name>"

backups() {
  # `sed` off the prefix rather than `find -printf`: -printf is a GNU extension and the postgres
  # image ships busybox find, where it silently produces nothing at all.
  #
  # `.part` is excluded because pg-backup.sh writes a backup under that suffix and only renames it
  # once pg_basebackup has succeeded. Restoring one gets a base.tar.gz with no pg_wal.tar.gz beside
  # it yet — which is the half-written backup that script's rename dance exists to prevent anyone
  # mistaking for a real one, and this script fell for it once before this line existed.
  docker run --rm -v "$BACKUP_VOLUME":/b:ro "$PG_IMAGE" \
    sh -c 'find /b -mindepth 1 -maxdepth 1 -type d ! -name "*.part" 2>/dev/null | sed "s#^/b/##" | sort'
}

# Listing creates nothing and touches nothing, so it runs before the primary is required.
if [ "$LIST" = true ]; then backups; exit 0; fi

# ── Discover the primary rather than assuming it ────────────────────────────────────────────────
# The volume actually mounted at the data directory, read off the running container. Discovered,
# not hardcoded: a hardcoded name is wrong the moment the compose project is renamed, and wrong
# silently, which is the worst way for a safety check to be wrong.
#
# A FAILURE HERE IS FATAL, not a warning. It used to fall back to "name pattern checks only", which
# is fail-OPEN: the single strongest guard — "is this the actual volume the primary is using?" —
# would quietly switch itself off in exactly the situation where the operator's mental model of the
# deployment is already wrong. And the verification step needs the primary running regardless, so
# continuing without it buys nothing.
PRIMARY_VOLUME="$(docker inspect "$PRIMARY_CONTAINER" \
  --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Name}}{{end}}{{end}}' \
  2>/dev/null || true)"
[ -n "$PRIMARY_VOLUME" ] || die "could not inspect '$PRIMARY_CONTAINER' to discover the primary data volume.
  Refusing to continue on name patterns alone — that would disable the strongest guard.
  Start the primary, or set PRIMARY_CONTAINER=<name> if this deployment names it differently."
say "primary data volume (never touched): $PRIMARY_VOLUME"

# ── Guards. All of them run BEFORE anything is created. ─────────────────────────────────────────
# Case-folded, because `POSTGRES_DATA` and `postgres_data` name the same mistake.
lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

guard_target() {
  local kind="$1" name="$2"
  [ -n "$name" ] || die "$kind name is empty"

  case "$(lower "$name")" in
    *postgres_data*|*postgres-data*)
      die "refusing: $kind '$name' contains 'postgres_data' — that is the primary's data volume" ;;
  esac

  # PRIMARY_VOLUME is guaranteed non-empty here — discovery is fatal above, deliberately, so this
  # check can never silently degrade into "no comparison performed".
  if [ "$(lower "$name")" = "$(lower "$PRIMARY_VOLUME")" ]; then
    die "refusing: $kind '$name' IS the primary data volume"
  fi

  if [ "$(lower "$name")" = "$(lower "$PRIMARY_CONTAINER")" ]; then
    die "refusing: $kind '$name' IS the primary container"
  fi
}

guard_target "scratch volume" "$SCRATCH_VOLUME"
guard_target "scratch container" "$SCRATCH_CONTAINER"

# A volume already in use by a container is somebody's live data, whatever it is called.
if docker volume inspect "$SCRATCH_VOLUME" >/dev/null 2>&1; then
  users="$(docker ps -a --filter "volume=$SCRATCH_VOLUME" --format '{{.Names}}' | tr '\n' ' ')"
  [ -z "${users// /}" ] || die "refusing: volume '$SCRATCH_VOLUME' is in use by: $users"
  die "refusing: volume '$SCRATCH_VOLUME' already exists — remove it or pass --volume <new-name>"
fi

if [ -n "$(docker ps -aq -f "name=^${SCRATCH_CONTAINER}$")" ]; then
  die "refusing: a container named '$SCRATCH_CONTAINER' already exists"
fi

# ── Pick a backup ───────────────────────────────────────────────────────────────────────────────
[ -n "$BACKUP" ] || BACKUP="$(backups | tail -n 1)"
[ -n "$BACKUP" ] || die "no backups found in volume '$BACKUP_VOLUME'"

# $BACKUP is interpolated into a `sh -c` string below, so it is validated against the exact shape
# pg-backup.sh generates rather than trusted. Without this, `--backup 'x; rm -rf /'` is command
# injection into that container and `--backup ../..` is a path escape out of /backups. The blast
# radius is one throwaway container with the backups volume mounted read-only, which is small —
# but "small blast radius" is not a reason to feed an argument to a shell unchecked.
printf '%s' "$BACKUP" | grep -qE '^[0-9]{8}T[0-9]{6}Z$' \
  || die "refusing: '--backup $BACKUP' is not a backup label (expected YYYYMMDDThhmmssZ)"
say "restoring backup: $BACKUP"

cleanup() {
  if [ "$KEEP" = true ]; then
    say "--keep: leaving container '$SCRATCH_CONTAINER' and volume '$SCRATCH_VOLUME' in place."
    say "        destroy with: docker rm -f $SCRATCH_CONTAINER && docker volume rm $SCRATCH_VOLUME"
    return
  fi
  docker rm -f "$SCRATCH_CONTAINER" >/dev/null 2>&1 || true
  docker volume rm "$SCRATCH_VOLUME" >/dev/null 2>&1 || true
  say "scratch instance destroyed"
}
trap cleanup EXIT

docker volume create "$SCRATCH_VOLUME" >/dev/null
docker run --rm \
  -v "$BACKUP_VOLUME":/backups:ro \
  -v "$SCRATCH_VOLUME":/restore \
  "$PG_IMAGE" sh -euc "
    tar -xzf /backups/$BACKUP/base.tar.gz   -C /restore
    tar -xzf /backups/$BACKUP/pg_wal.tar.gz -C /restore/pg_wal
    chown -R 70:70 /restore && chmod 0700 /restore"

# archive_mode=off is not optional — see the header. No published port: nothing outside this host
# has any business reaching a restored copy of production data.
docker run -d --name "$SCRATCH_CONTAINER" \
  -v "$SCRATCH_VOLUME":/var/lib/postgresql/data \
  "$PG_IMAGE" postgres -c archive_mode=off -c listen_addresses=localhost >/dev/null

say "waiting for recovery..."
for _ in $(seq 1 60); do
  if docker exec "$SCRATCH_CONTAINER" pg_isready -U opengateway >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$SCRATCH_CONTAINER" pg_isready -U opengateway >/dev/null 2>&1 \
  || die "scratch instance did not become ready; see: docker logs $SCRATCH_CONTAINER"

# ── Verify by exact row counts, every database ──────────────────────────────────────────────────
# Exact counts via query_to_xml, not pg_stat estimates: an estimate that happens to match is not
# evidence. The primary is only ever READ here.
COUNT_SQL="select relname, (xpath('/row/c/text()', x))[1]::text::bigint as n from (
  select relname, query_to_xml(format('select count(*) as c from %I.%I', schemaname, relname), false, true, '') as x
  from pg_stat_user_tables) t order by relname;"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"; cleanup' EXIT

# Errors are NOT swallowed. This loop used to end `2>/dev/null || true` on both calls, which meant
# that if psql failed on BOTH sides — primary stopped, role renamed in another deployment, image
# without psql — each file held nothing but its four `###` headers, `diff` found them identical,
# and the script printed "PASS: every table's row count matches the primary" directly under
# "compared 0 tables". A verification that reports success when it verified nothing is worse than
# no verification, because it is the one an operator believes.
dump_counts() {
  container="$1"; out="$2"
  : >"$out"
  for db in opengateway hydra kratos keto; do
    echo "### $db" >>"$out"
    docker exec "$container" psql -U opengateway -d "$db" -tAF'|' -c "$COUNT_SQL" >>"$out" 2>"$tmp/psql.err" \
      || die "row count query failed on $container/$db: $(tr '\n' ' ' <"$tmp/psql.err")"
  done
}

dump_counts "$SCRATCH_CONTAINER" "$tmp/scratch.txt"
dump_counts "$PRIMARY_CONTAINER" "$tmp/primary.txt"

s_tables="$(grep -cv '^###' "$tmp/scratch.txt" || true)"
p_tables="$(grep -cv '^###' "$tmp/primary.txt" || true)"

# Three ways the comparison can be meaningless; all three are fatal rather than a quiet PASS.
[ "$s_tables" -gt 0 ] || die "the restored instance reports 0 tables — the restore produced an empty cluster"
[ "$p_tables" -gt 0 ] || die "the primary reports 0 tables — there is nothing to verify against"
[ "$s_tables" = "$p_tables" ] || die "table COUNT differs: primary $p_tables, restored $s_tables.
  A table created after this backup was taken will do that; so will a partial restore.
  Compare the table lists before trusting either instance."

say "compared $s_tables tables across 4 databases"

if diff -u "$tmp/primary.txt" "$tmp/scratch.txt" >"$tmp/diff.txt"; then
  say "PASS: every table's row count matches the primary"
  exit 0
fi

# Per-database verdict before the raw diff. On a live stack the Ory databases drift within seconds
# of any login, so "it differs" on its own tells an operator nothing about whether the BACKUP is
# good. Which databases differ is the part that does: `opengateway` matching while hydra/kratos/keto
# have moved is normal traffic; `opengateway` differing is the one that warrants a closer look.
say "MISMATCH — a primary that took writes after the backup will differ here; that is not a bad backup."
for db in opengateway hydra kratos keto; do
  a="$(awk -v d="$db" '/^###/{s=($2==d)} s&&!/^###/' "$tmp/primary.txt")"
  b="$(awk -v d="$db" '/^###/{s=($2==d)} s&&!/^###/' "$tmp/scratch.txt")"
  if [ "$a" = "$b" ]; then say "  $db: identical"; else say "  $db: DIFFERS"; fi
done
cat "$tmp/diff.txt"
exit 1
