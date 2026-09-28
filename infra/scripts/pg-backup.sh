#!/bin/sh
# Scheduled Postgres base backups (WP29a). Entrypoint of the `postgres-backup` service.
#
# A `sleep` loop rather than cron: the alpine postgres image ships no crond, and adding one to run a
# single job is more moving parts than the job. `restart: unless-stopped` covers the process dying.
#
# `-X stream` makes each base backup SELF-CONTAINED (the WAL generated during the backup rides
# along in pg_wal.tar.gz), so a restore is untar + start with no archive needed. The archive in
# /wal_archive is for point-in-time recovery PAST the backup, not for making the backup work — the
# two answer different questions and only the first one has to be right at 3am.
#
# ── Restore: infra/scripts/pg-restore-scratch.sh ───────────────────────────────────────────────
#   infra/scripts/pg-restore-scratch.sh            # latest backup -> scratch, verify, destroy
#   infra/scripts/pg-restore-scratch.sh --list
#
# That is a SCRIPT and not a procedure in this comment on purpose. This block used to spell the
# restore out as copy-pasteable docker commands, and a reviewer pointed out the obvious: prose
# cannot refuse a bad volume name. Restoring over the primary's data directory is the one mistake
# in this repository that destroys data irrecoverably, so the safeguard has to be executable —
# the script refuses any target naming `postgres_data`, or matching the primary's actual volume
# (discovered by inspecting the running container, not hardcoded), or already in use, before it
# creates anything. It also forces `archive_mode=off` on the scratch instance, which is not
# optional: left on it inherits the primary's archive_command, has no /wal_archive to write to and
# jams its own pg_wal — and if it DID get that volume it would write the restored cluster's
# segments over the primary's archive.
set -eu

: "${PG_BACKUP_INTERVAL:=86400}"
: "${PG_BACKUP_KEEP:=7}"

log() { echo "[pg-backup] $*"; }

# PG-08 (backup freshness): write the same success signal `.last-success` records, as a Prometheus
# textfile. `/textfile` is the `og_textfile` volume (C1) — mounted only once the compose side of
# this lands, so an older compose or a mid-rollout mismatch just means the directory is missing.
# That is never a reason to fail a backup that otherwise succeeded: this collector runs after
# `.last-success` is already written, and returns 0 either way.
write_metric() {
  [ -d /textfile ] || return 0
  tmp="/textfile/.og_backup.prom.$$"
  {
    echo '# HELP og_backup_last_success_timestamp_seconds Last successful pg_basebackup (epoch seconds).'
    echo '# TYPE og_backup_last_success_timestamp_seconds gauge'
    echo "og_backup_last_success_timestamp_seconds{kind=\"pg_base\"} $(date +%s)"
  } >"$tmp" && chmod 0644 "$tmp" && mv "$tmp" /textfile/og_backup.prom
}

# Prune base backups beyond PG_BACKUP_KEEP, then drop every WAL segment older than the START WAL of
# the OLDEST backup still kept. An archive that outlives every base backup it could be replayed onto
# is just disk; pruning it the other way round (by age) can orphan a backup that needs it.
prune() {
  # `find -maxdepth 1 -type d`, not `ls`: busybox `head` has no negative-count form and the glob
  # would otherwise survive literally when /backups holds no backup yet.
  kept=$(find /backups -mindepth 1 -maxdepth 1 -type d | sort)
  [ -n "$kept" ] || return 0

  drop=$(($(echo "$kept" | wc -l) - PG_BACKUP_KEEP))
  if [ "$drop" -gt 0 ]; then
    echo "$kept" | head -n "$drop" | while IFS= read -r old; do
      log "pruning $old"
      rm -rf "$old"
    done
    kept=$(find /backups -mindepth 1 -maxdepth 1 -type d | sort)
  fi

  oldest=$(echo "$kept" | head -n 1)
  [ -n "$oldest" ] || return 0

  # backup_label lives inside base.tar.gz; its START WAL LOCATION names the first segment any
  # restore of that backup could need.
  start_wal=$(tar -xOzf "$oldest/base.tar.gz" backup_label 2>/dev/null |
    sed -n 's/^START WAL LOCATION: .*(file \([0-9A-F]\{24\}\))$/\1/p')
  if [ -n "${start_wal:-}" ]; then
    pg_archivecleanup /wal_archive "$start_wal"
  else
    log "WARNING: no START WAL in $oldest/base.tar.gz; leaving /wal_archive alone"
  fi
}

while :; do
  label=$(date -u +%Y%m%dT%H%M%SZ)
  # Write to .part and rename: a half-written directory that looks like a backup is worse than no
  # backup, because retention would count it and prune a good one.
  if pg_basebackup -D "/backups/$label.part" -Ft -z -Xs -c fast --no-password; then
    mv "/backups/$label.part" "/backups/$label"
    date +%s >/backups/.last-success
    write_metric || log "WARNING: textfile metric write failed; backup itself is fine"
    log "base backup $label complete"
    prune || log "WARNING: prune failed; backup itself is fine"
  else
    log "ERROR: base backup $label FAILED"
    rm -rf "/backups/$label.part"
  fi
  sleep "$PG_BACKUP_INTERVAL"
done
