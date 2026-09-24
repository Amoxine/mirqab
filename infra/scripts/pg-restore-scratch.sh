#!/usr/bin/env bash
# Restore a Postgres base backup to a SCRATCH instance and verify it (WP29a).
#
# This exists as a script rather than a documented procedure for one reason: it is the only
# operation in this repository where a typo destroys data that cannot be recovered. A runbook
# cannot refuse a bad volume name at 3am; this can, and does, before it creates anything.
#
#   infra/scripts/pg-restore-scratch.sh                      # latest backup -> scratch, verify, destroy
#   infra/scripts/pg-restore-scratch.sh --backup 20260924T172613Z
#   infra/scripts/pg-restore-scratch.sh --keep               # leave the scratch instance running
#   infra/scripts/pg-restore-scratch.sh --strict             # also require counts to equal the primary
#   infra/scripts/pg-restore-scratch.sh --list               # just show available backups
#
# ── What the verdict means ──────────────────────────────────────────────────────────────────────
# The first version of this compared row counts against the primary and failed on any difference.
# That oracle is WRONG on a live system, not merely strict: the primary keeps taking writes, so one
# audit_logs row between backup and check made a perfect restore report failure. A check that can
# never go green is a check people stop reading — the same defect this repo hit with
# `prisma migrate diff --exit-code`.
#
# So the verdict is four layers, and each says what it proved:
#
#   L1  pg_verifybackup over the extracted files, BEFORE the server starts
#         -> "the backup is intact and complete" (every file matches the manifest's checksum)
#   L2  server starts, recovery completes, all four databases open and answer a query
#         -> "the restore works"
#   L3  table SET identical to the primary, and no restored table empty where the primary's is not
#         -> "the backup is not hollow, stale, or of the wrong cluster"
#   L4  pg_amcheck across the restored databases (skipped with a note if unavailable)
#         -> "no page or index corruption in the restored relations"
#
# Row-count differences against the primary are printed as DRIFT INFORMATION, not failure, because
# writes since the backup are expected. `--strict` demands exact equality for a quiescent window.
#
# ── What this does NOT prove ────────────────────────────────────────────────────────────────────
# Row VALUES are never compared against the primary, and nothing honestly can: the primary is a
# moving target, so any value-level diff would be reporting normal traffic as corruption. Fidelity
# comes from L1+L2 instead — if every file matches the manifest and the server recovers to a
# consistent state, the restored data IS what the backup held. L3's job is narrower and different:
# catching a backup that is hollow, stale, or of the wrong cluster, which the table set and
# non-emptiness can vouch for because those do not move minute to minute.
# An exit 0 therefore means "this backup is intact and restorable", never "this equals the primary".
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
STRICT=false

die() { echo "ERROR: $*" >&2; exit 1; }
say() { echo "[restore] $*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --backup) BACKUP="${2:-}"; shift 2 ;;
    --volume) SCRATCH_VOLUME="${2:-}"; shift 2 ;;
    --container) SCRATCH_CONTAINER="${2:-}"; shift 2 ;;
    --keep) KEEP=true; shift ;;
    --list) LIST=true; shift ;;
    --strict) STRICT=true; shift ;;
    -h|--help) sed -n '2,50p' "$0"; exit 0 ;;
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

  # Shape check FIRST, and explicit rather than incidental. A path like `/etc` or `../../host` is
  # refused today only because Docker rejects it as a volume name and `set -e` then aborts — which
  # means relaxing `set -e` for any unrelated reason silently re-opens a bind mount into an
  # arbitrary host directory, with nothing in this script noticing. Docker's own rule is
  # [a-zA-Z0-9][a-zA-Z0-9_.-]*; a `case` glob, not grep, for the newline reason given further down.
  case "$name" in
    [A-Za-z0-9]*) ;;
    *) die "refusing: $kind '$name' must start with a letter or digit" ;;
  esac
  case "$name" in
    *[!A-Za-z0-9_.-]*)
      die "refusing: $kind '$name' contains characters outside [A-Za-z0-9_.-] — a path or a
  multi-line value is not a docker name, and must not reach a -v flag" ;;
  esac

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
#
# A `case` GLOB, not `grep -qE '^...$'`. grep is line-oriented: it succeeds when ANY line matches,
# so a multi-line value whose FIRST line is a valid label passes the check and then carries its
# remaining lines straight into the shell — `20260924T172613Z\ntouch /tmp/pwned` validated clean and
# put `touch /tmp/pwned/base.tar.gz` on its own line inside the container. A glob matches the whole
# string and cannot match across a newline, which is the property actually wanted here. This is the
# second time in this file that a check looked right and tested nothing; anchors in a line-oriented
# tool are not string anchors.
case "$BACKUP" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z) ;;
  *) die "refusing: '--backup $BACKUP' is not a backup label (expected YYYYMMDDThhmmssZ)" ;;
esac
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

# The manifest is copied out of the backup DIRECTORY, not out of base.tar.gz — pg_basebackup -Ft
# writes backup_manifest beside the tarballs, not inside them. Without it L1 fails for the wrong
# reason ("could not open file backup_manifest"), which during development read as a successful
# corruption detection and was not one.
docker run --rm \
  -v "$BACKUP_VOLUME":/backups:ro \
  -v "$SCRATCH_VOLUME":/restore \
  "$PG_IMAGE" sh -euc "
    tar -xzf /backups/$BACKUP/base.tar.gz   -C /restore
    tar -xzf /backups/$BACKUP/pg_wal.tar.gz -C /restore/pg_wal
    cp /backups/$BACKUP/backup_manifest /restore/backup_manifest
    chown -R 70:70 /restore && chmod 0700 /restore"

# ── L0: the backup's major version matches the image ────────────────────────────────────────────
# Before L1, because otherwise a perfectly good backup from another major version is reported as
# CORRUPT. Measured: restoring a valid PostgreSQL 15 backup with the 16 image makes pg_waldump fail
# with "could not find a valid record", which pg_verifybackup surfaces as "WAL parsing failed" and
# this script would then announce as "the backup is corrupt or incomplete — do not rely on it".
# That sends an operator hunting a corruption that does not exist, at the worst possible moment;
# the backup is fine and the IMAGE is wrong. Restoring across a major version needs pg_upgrade, not
# this script.
backup_pgver="$(docker run --rm -v "$SCRATCH_VOLUME":/restore:ro "$PG_IMAGE" cat /restore/PG_VERSION 2>/dev/null | tr -d '[:space:]')"
image_pgver="$(docker run --rm "$PG_IMAGE" postgres --version | sed -E 's/.* ([0-9]+)\..*/\1/')"
[ -n "$backup_pgver" ] || die "the extracted backup has no PG_VERSION file — it is not a data directory"
if [ "$backup_pgver" != "$image_pgver" ]; then
  die "L0 FAILED: backup is PostgreSQL $backup_pgver but $PG_IMAGE is $image_pgver.
  The backup is not necessarily bad — this image cannot read it. Restore it with a postgres:$backup_pgver
  image (PG_IMAGE=postgres:$backup_pgver-alpine) or run pg_upgrade. Do NOT read a WAL-parsing error
  from a cross-version restore as corruption."
fi
say "L0 PASS: backup and image are both PostgreSQL $image_pgver"

# ── L1: the backup is intact and complete ───────────────────────────────────────────────────────
# Runs BEFORE the server starts, deliberately: starting postgres rewrites control files and replays
# WAL, so every later checksum would legitimately differ from the manifest and the layer would be
# useless. This is the only layer that sees content — it checksums every file — which is what makes
# it the answer to "could a corruption that preserves row counts slip through?". Verified: 14 bytes
# changed in a relation file, size identical, -> "checksum mismatch for file base/1/1255".
say "L1: verifying the backup against its manifest (pg_verifybackup)..."
if ! docker run --rm -v "$SCRATCH_VOLUME":/restore "$PG_IMAGE" \
     pg_verifybackup /restore >"${TMPDIR:-/tmp}/vb.$$" 2>&1; then
  say "L1 FAILED:"; sed 's/^/    /' "${TMPDIR:-/tmp}/vb.$$" >&2; rm -f "${TMPDIR:-/tmp}/vb.$$"
  die "the backup is corrupt or incomplete — do not rely on it"
fi
rm -f "${TMPDIR:-/tmp}/vb.$$"
say "L1 PASS: every file matches the manifest checksum"

# archive_mode=off is not optional — see the header. No published port: nothing outside this host
# has any business reaching a restored copy of production data.
docker run -d --name "$SCRATCH_CONTAINER" \
  -v "$SCRATCH_VOLUME":/var/lib/postgresql/data \
  "$PG_IMAGE" postgres -c archive_mode=off -c listen_addresses=localhost >/dev/null

# ── L2: the restore works ───────────────────────────────────────────────────────────────────────
say "L2: waiting for recovery and opening every database..."
for _ in $(seq 1 60); do
  if docker exec "$SCRATCH_CONTAINER" pg_isready -U opengateway >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$SCRATCH_CONTAINER" pg_isready -U opengateway >/dev/null 2>&1 \
  || die "L2 FAILED: the restored cluster never reached a consistent state.
  docker logs $SCRATCH_CONTAINER --tail 40"

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
# Emits `db|table|count`, one line per table, DATABASE-QUALIFIED. That qualification is not
# cosmetic: `schema_migration` and `networks` each exist in hydra, kratos AND keto, so a map keyed
# on table name alone silently compares keto's schema_migration (17 rows) against hydra's (224) —
# which is exactly what the first version of the drift report printed, and what the hollow check
# was doing invisibly. Unqualified names in a multi-database comparison are a latent wrong answer.
dump_counts() {
  container="$1"; out="$2"
  : >"$out"
  for db in opengateway hydra kratos keto; do
    docker exec "$container" psql -U opengateway -d "$db" -tAF'|' -c "$COUNT_SQL" 2>"$tmp/psql.err" \
      | sed "s/^/$db|/" >>"$out" \
      || die "row count query failed on $container/$db: $(tr '\n' ' ' <"$tmp/psql.err")"
  done
}

dump_counts "$SCRATCH_CONTAINER" "$tmp/scratch.txt"
dump_counts "$PRIMARY_CONTAINER" "$tmp/primary.txt"

say "L2 PASS: recovery completed and all four databases answered"

# ── L3: the backup is not hollow, stale, or of the wrong cluster ────────────────────────────────
# What L3 can and cannot do, stated because the previous version got this wrong: it CANNOT prove
# row-level fidelity against a primary that keeps moving, and nothing can. Fidelity is L1+L2's job.
# L3 checks the two things that do NOT move minute to minute and that a wrong or hollow backup
# fails immediately — the table SET, and tables being non-empty where the primary's are.
s_tables="$(wc -l <"$tmp/scratch.txt" | tr -d ' ')"
p_tables="$(wc -l <"$tmp/primary.txt" | tr -d ' ')"
[ "$s_tables" -gt 0 ] || die "L3 FAILED: the restored cluster has 0 user tables — the backup is empty"
[ "$p_tables" -gt 0 ] || die "L3 FAILED: the primary reports 0 tables — there is nothing to compare against"

# Table SET (db-qualified), not count: the same NUMBER of differently-named tables is a
# wrong-cluster backup, and a count comparison waves it straight through.
cut -d'|' -f1,2 <"$tmp/scratch.txt" | sort >"$tmp/s.set"
cut -d'|' -f1,2 <"$tmp/primary.txt" | sort >"$tmp/p.set"
if ! diff -u "$tmp/p.set" "$tmp/s.set" >"$tmp/set.diff"; then
  say "L3 FAILED: the restored table set differs from the primary's"
  sed -n '3,$p' "$tmp/set.diff" | sed 's/^/    /' >&2
  die "this backup is of a different cluster, a different schema version, or is incomplete"
fi

# Hollow check: a table the primary has rows in must not come back empty. This is what catches a
# backup that restored structure but no data — which a count DIFF would merely call "drift".
hollow=0
while IFS='|' read -r db t pn; do
  [ -n "${t:-}" ] || continue
  sn="$(awk -F'|' -v d="$db" -v k="$t" '$1==d && $2==k {print $3; exit}' "$tmp/scratch.txt")"
  if [ "${pn:-0}" -gt 0 ] && [ "${sn:-0}" -eq 0 ]; then
    say "  HOLLOW: $db.$t — primary has $pn rows, restored has 0"
    hollow=1
  fi
done <"$tmp/primary.txt"
[ "$hollow" -eq 0 ] || die "L3 FAILED: restored tables are empty where the primary's are not"
say "L3 PASS: $s_tables tables, table set identical, no hollow tables"

# ── L4: no page or index corruption (optional) ──────────────────────────────────────────────────
if docker exec "$SCRATCH_CONTAINER" sh -c 'command -v pg_amcheck' >/dev/null 2>&1; then
  amfail=0
  for db in opengateway hydra kratos keto; do
    docker exec "$SCRATCH_CONTAINER" psql -U opengateway -d "$db" -qc 'CREATE EXTENSION IF NOT EXISTS amcheck' >/dev/null 2>&1 || true
    docker exec "$SCRATCH_CONTAINER" pg_amcheck -U opengateway -d "$db" >>"$tmp/am.out" 2>&1 || amfail=1
  done
  if [ "$amfail" -ne 0 ]; then
    say "L4 FAILED:"; sed 's/^/    /' "$tmp/am.out" >&2
    die "pg_amcheck found corruption in the restored relations"
  fi
  say "L4 PASS: pg_amcheck found no page or index corruption"
else
  say "L4 SKIPPED: pg_amcheck is not in $PG_IMAGE"
fi

# ── Drift: information, not a verdict ───────────────────────────────────────────────────────────
if diff -u "$tmp/primary.txt" "$tmp/scratch.txt" >"$tmp/diff.txt"; then
  say "drift: none — counts equal the primary (the stack was quiet during the check)"
else
  say "drift vs the primary (EXPECTED — the primary took writes after the backup):"
  for db in opengateway hydra kratos keto; do
    a="$(awk -F'|' -v d="$db" '$1==d' "$tmp/primary.txt")"
    b="$(awk -F'|' -v d="$db" '$1==d' "$tmp/scratch.txt")"
    [ "$a" = "$b" ] && say "  $db: identical" || say "  $db: moved"
  done
  # Keyed on db|table, never table alone — see dump_counts.
  awk -F'|' 'NR==FNR{p[$1"|"$2]=$3; next} {k=$1"|"$2} k in p && p[k]!=$3 {printf "    %-44s primary %s, restored %s\n", k, p[k], $3}' \
    "$tmp/primary.txt" "$tmp/scratch.txt"
  if [ "$STRICT" = true ]; then
    die "--strict: counts must equal the primary, and they do not"
  fi
fi

say "PASS: backup '$BACKUP' is intact (L1), restorable (L2) and complete (L3)."
say "      NOT proven: row VALUES equal the primary's — the primary moves, so nothing can prove that."
exit 0
