#!/usr/bin/env bash
# Tests the L3 table-set logic of infra/scripts/pg-restore-scratch.sh by RUNNING it: the real definitions
# are extracted from the script (not copied here), so editing them there changes what this tests.
#
#   bash infra/scripts/pg-restore-scratch.check.sh
#   RESTORE_SCRIPT=/path/to/mutated.sh bash infra/scripts/pg-restore-scratch.check.sh   # prove a case can fail
#
# What it pins. L3 compares the db-qualified table SET of a restored backup with the primary's. The search
# projection keeps one partition per UTC day (`og_traffic_search_YYYYMMDD`), created two days ahead and
# dropped on expiry, so that set rotates every midnight; base backups are daily. Comparing the partitions
# made a perfectly healthy backup older than the last rotation exit 1 with "different cluster / schema
# version". The partitions are excluded, and the exclusion must be exactly as wide as that: a REAL missing
# table, the parent `og_traffic_search`, or `og_traffic_search_state` still has to fail.
#
# Not covered, and said so: the script as a whole needs Docker, a backup volume and a running primary and
# was never run by this test; only the pure pieces are. The wiring is checked as text (dump_counts feeds
# every row through the filter; L3 calls table_set_diff), which is weaker than running it and is why the
# pieces are small. SQL-level facts (that pg_stat_user_tables lists the parent and the partitions) were
# checked by hand against a throwaway Postgres, not here.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
SCRIPT=${RESTORE_SCRIPT:-$here/pg-restore-scratch.sh}
[ -r "$SCRIPT" ] || { echo "no script at $SCRIPT" >&2; exit 2; }

# ── load the real definitions ───────────────────────────────────────────────────────────────────────
row_re_line=$(grep -E '^ROTATING_PARTITION_ROW=' "$SCRIPT" || true)
filter_line=$(grep -E '^without_rotating_partitions\(\)' "$SCRIPT" || true)
diff_fn=$(sed -n '/^table_set_diff() {/,/^}/p' "$SCRIPT")
dump_fn=$(sed -n '/^dump_counts() {/,/^}/p' "$SCRIPT")
[ -n "$row_re_line" ] && [ -n "$filter_line" ] && [ -n "$diff_fn" ] && [ -n "$dump_fn" ] \
  || { echo "could not find the L3 definitions in $SCRIPT (ROTATING_PARTITION_ROW / without_rotating_partitions / table_set_diff / dump_counts)" >&2; exit 2; }
eval "$row_re_line"
eval "$filter_line"
eval "$diff_fn"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

total=0
failed=0
note_fail() { failed=$((failed + 1)); echo "  CASE FAILED: $*"; }
check_true() { total=$((total + 1)); label=$1; shift; "$@" || note_fail "$label"; }

# rows <file> db|table|count ... — writes one row per argument.
rows() { f=$1; shift; : >"$f"; for r in "$@"; do printf '%s\n' "$r" >>"$f"; done; }
# filtered <in> <out> — what dump_counts writes: the same filter, applied to the same row shape.
filtered() { without_rotating_partitions <"$1" >"$2"; }

# diff_rc <primary> <scratch> — runs table_set_diff on FILTERED copies; sets DIFF_BODY and returns its status.
diff_rc() {
  filtered "$1" "$tmp/p.f"
  filtered "$2" "$tmp/s.f"
  DIFF_BODY=$(table_set_diff "$tmp/p.f" "$tmp/s.f" "$tmp")
}
# raw_diff_rc — the same WITHOUT the filter: what the script did before the fix.
raw_diff_rc() { DIFF_BODY=$(table_set_diff "$1" "$2" "$tmp"); }

BASE=(
  'opengateway|users|9'
  'opengateway|tenants|2'
  'opengateway|og_traffic_search|120'
  'opengateway|og_traffic_search_state|1'
  'hydra|hydra_client|3'
  'kratos|identities|4'
  'keto|keto_relation_tuples|5'
)
# The primary today: partitions for today and the two days ahead.
PRIMARY=("${BASE[@]}" 'opengateway|og_traffic_search_20261003|70' 'opengateway|og_traffic_search_20261004|0' 'opengateway|og_traffic_search_20261005|0')
# A backup taken two days ago: it holds the partitions that existed then, none of today's.
OLD_BACKUP=("${BASE[@]}" 'opengateway|og_traffic_search_20261001|50' 'opengateway|og_traffic_search_20261002|60' 'opengateway|og_traffic_search_20261003|10')

echo "the filter"
rows "$tmp/in" \
  'opengateway|og_traffic_search|5' \
  'opengateway|og_traffic_search_20261003|3' \
  'opengateway|og_traffic_search_state|1' \
  'opengateway|og_traffic_search_2026100|1' \
  'opengateway|og_traffic_search_202610031|1' \
  'opengateway|og_traffic_search_20261003x|1' \
  'opengateway|og_traffic_search_20261003_old|1' \
  'opengateway|og_traffic_search_ABCDEFGH|1' \
  'opengateway|x_og_traffic_search_20261003|1' \
  'opengateway|users|9' \
  'hydra|og_traffic_search_20261004|2'
filtered "$tmp/in" "$tmp/out"
expected='opengateway|og_traffic_search|5
opengateway|og_traffic_search_state|1
opengateway|og_traffic_search_2026100|1
opengateway|og_traffic_search_202610031|1
opengateway|og_traffic_search_20261003x|1
opengateway|og_traffic_search_20261003_old|1
opengateway|og_traffic_search_ABCDEFGH|1
opengateway|x_og_traffic_search_20261003|1
opengateway|users|9'
check_true "removes exactly the eight-digit partitions and nothing else" test "$(cat "$tmp/out")" = "$expected"
# A row whose COUNT contains the pattern text must not be mistaken for a partition name.
rows "$tmp/in" 'opengateway|users|20261003'
filtered "$tmp/in" "$tmp/out"
check_true "only the table field is matched, not the count" test "$(cat "$tmp/out")" = 'opengateway|users|20261003'
# Every row filtered out is not an error (grep -v exits 1 on no output; pipefail must not turn that into one).
rows "$tmp/in" 'opengateway|og_traffic_search_20261003|1'
all_partitions_ok() { ( set -o pipefail; without_rotating_partitions <"$tmp/in" >"$tmp/out" ); }
check_true "an input that is all partitions exits 0 under pipefail" all_partitions_ok
check_true "...and its output is empty" test ! -s "$tmp/out"

echo "table set comparison"
rows "$tmp/p" "${PRIMARY[@]}"
rows "$tmp/s" "${OLD_BACKUP[@]}"
raw_diff_rc "$tmp/p" "$tmp/s"
raw_rc=$?
check_true "BEFORE the fix the partition rotation alone makes a healthy backup fail (the bug, reproduced)" test "$raw_rc" -eq 1
diff_rc "$tmp/p" "$tmp/s"
check_true "a healthy backup older than the last rotation PASSES (partition sets differ, nothing else does)" test "$?" -eq 0

rows "$tmp/s" "${PRIMARY[@]}"
diff_rc "$tmp/p" "$tmp/s"
check_true "identical sets pass" test "$?" -eq 0

# A real missing table must still fail, with or without a partition difference alongside.
without() { local skip=$1; shift; for r in "$@"; do case "$r" in "$skip"\|*) ;; *) printf '%s\n' "$r" ;; esac; done; }
for missing in 'opengateway|users' 'opengateway|og_traffic_search' 'opengateway|og_traffic_search_state' 'hydra|hydra_client' 'keto|keto_relation_tuples'; do
  mapfile -t s_rows < <(without "$missing" "${OLD_BACKUP[@]}")
  rows "$tmp/s" "${s_rows[@]}"
  diff_rc "$tmp/p" "$tmp/s"
  rc=$?
  check_true "missing $missing FAILS (even with the partition sets differing too)" test "$rc" -eq 1
  check_true "...and the diff names ${missing#*|}" bash -c 'printf "%s\n" "$1" | grep -qF -- "$2"' _ "$DIFF_BODY" "${missing#*|}"
  check_true "...and the diff does not drown it in partition names" bash -c '! printf "%s\n" "$1" | grep -q "og_traffic_search_2026"' _ "$DIFF_BODY"
done

# An EXTRA table in the backup (one the primary lacks) is also a difference.
rows "$tmp/s" "${PRIMARY[@]}" 'opengateway|surprise_table|1'
diff_rc "$tmp/p" "$tmp/s"
check_true "an extra table in the backup FAILS" test "$?" -eq 1

# A same-named table in another database is a different table: db-qualified.
rows "$tmp/s" $(printf '%s\n' "${PRIMARY[@]}" | grep -v '^hydra|') 'keto|hydra_client|3'
diff_rc "$tmp/p" "$tmp/s"
check_true "a table under the wrong database FAILS" test "$?" -eq 1

# Near-miss names are real tables and are NOT excluded: a missing one fails.
rows "$tmp/p" "${BASE[@]}" 'opengateway|og_traffic_search_2026100|1'
rows "$tmp/s" "${BASE[@]}"
diff_rc "$tmp/p" "$tmp/s"
check_true "a missing og_traffic_search_2026100 (seven digits) is a REAL missing table and FAILS" test "$?" -eq 1

echo "wiring (as text)"
check_true "dump_counts feeds every row through the filter" bash -c 'printf "%s\n" "$1" | grep -q "without_rotating_partitions"' _ "$dump_fn"
check_true "the L3 check calls table_set_diff" grep -qE '^if ! set_diff_body="\$\(table_set_diff ' "$SCRIPT"
not_in_file() { ! grep -qF -- "$1" "$2"; }
check_true "L3 no longer diffs the raw files itself" not_in_file '"$tmp/p.set"' "$SCRIPT"

echo
if [ "$failed" -eq 0 ]; then
  echo "pg-restore-scratch.check: all $total assertions passed"
  exit 0
fi
echo "pg-restore-scratch.check: $failed of $total assertions FAILED" >&2
exit 1
