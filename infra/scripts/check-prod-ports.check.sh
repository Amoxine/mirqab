#!/usr/bin/env bash
# Tests infra/scripts/check-prod-ports.sh against a fake `docker` on PATH.
#
#   bash infra/scripts/check-prod-ports.check.sh
#   GUARD=/path/to/mutated.sh bash infra/scripts/check-prod-ports.check.sh   # prove a case can fail
#
# The guard's whole job is to fail when production would publish something other than the edge's
# five ports, or when Compose is too old to honour `!reset`. A guard nobody has watched fail is a
# guess, so every refusal below must be seen to refuse, next to the passing cases that show it is not
# refusing everything. The shim stands in for `docker compose version --short` and
# `docker compose ... config --format json`; the real rendering is exercised separately by running
# the guard itself (no shim) against the real compose files.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
GUARD=${GUARD:-$here/check-prod-ports.sh}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
mkdir "$tmp/bin"

cat >"$tmp/bin/docker" <<'EOF'
#!/bin/sh
# SHIM_VERSION: what `docker compose version --short` prints (empty = the command fails).
# SHIM_RENDER=fail: `config` fails. SHIM_JSON / SHIM_JSON_NOPROFILE: files holding the rendered JSON
# for a run WITH and WITHOUT a --profile flag (the second defaults to the first).
if [ "$1" = compose ] && [ "$2" = version ]; then
  [ -n "${SHIM_VERSION:-}" ] || exit 1
  echo "$SHIM_VERSION"
  exit 0
fi
case " $* " in
  *' config '*)
    if [ "${SHIM_RENDER:-ok}" = fail ]; then
      echo "error while interpolating services.kratos.environment.X: required variable Y is missing a value" >&2
      exit 1
    fi
    case " $* " in
      *' --profile '*) cat "$SHIM_JSON" ;;
      *) cat "${SHIM_JSON_NOPROFILE:-$SHIM_JSON}" ;;
    esac ;;
esac
EOF
chmod +x "$tmp/bin/docker"

# ports_json <file> <port|random>... — a minimal `config --format json` holding those port mappings.
# "random" is a mapping with a target and no published port (`ports: - "8080"`).
ports_json() {
  out=$1
  shift
  {
    printf '{\n  "name": "t",\n  "services": {\n    "edge": {\n      "ports": [\n'
    first=1
    for p in "$@"; do
      [ "$first" -eq 1 ] || printf ',\n'
      first=0
      if [ "$p" = random ]; then
        printf '        {\n          "mode": "ingress",\n          "target": 8080,\n          "protocol": "tcp"\n        }'
      else
        printf '        {\n          "mode": "ingress",\n          "target": %s,\n          "published": "%s",\n          "protocol": "tcp"\n        }' "$p" "$p"
      fi
    done
    # A volume target is a quoted string and must not be counted as a port mapping.
    printf '\n      ],\n      "volumes": [{"type": "bind", "target": "/etc/caddy/Caddyfile"}]\n    }\n  }\n}\n'
  } >"$out"
}

FIVE="33000 33001 33005 33010 33012"
ports_json "$tmp/five.json" $FIVE
ports_json "$tmp/extra-kratos.json" $FIVE 33013
ports_json "$tmp/extra-tcp.json" $FIVE 33020
ports_json "$tmp/extra-mailpit.json" $FIVE 33016
ports_json "$tmp/missing.json" 33000 33001 33010 33012
ports_json "$tmp/random.json" $FIVE random
ports_json "$tmp/none.json"

total=0
failed=0
note_fail() { failed=$((failed + 1)); echo "  CASE FAILED: $*"; }

# run <pass|fail> <fixed text expected in the output> <label> [VAR=value]...
run() {
  want=$1 text=$2 label=$3
  shift 3
  total=$((total + 1))
  out=$(
    export SHIM_VERSION=5.1.4 SHIM_JSON=$tmp/five.json
    for a in "$@"; do export "$a"; done
    # Called by path, with the shim first on PATH. `--env-file /dev/null` keeps the guard from writing
    # its dummy file: the shim does not read it.
    PATH="$tmp/bin:$PATH" bash "$GUARD" --env-file /dev/null 2>&1
  )
  rc=$?
  if [ "$want" = pass ]; then
    { [ "$rc" -eq 0 ] && printf '%s\n' "$out" | grep -qF -- "$text"; } \
      || { note_fail "$label — expected exit 0 with '$text', got exit $rc"; printf '%s\n' "$out" | sed 's/^/      | /'; }
  else
    { [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -qF -- "$text"; } \
      || { note_fail "$label — expected a non-zero exit with '$text', got exit $rc"; printf '%s\n' "$out" | sed 's/^/      | /'; }
  fi
}

echo "versions"
run pass "production publishes only $FIVE" "Compose 5.1.4" SHIM_VERSION=5.1.4
run pass "Compose 2.24.0" "2.24.0 is the minimum" SHIM_VERSION=2.24.0
run pass "Compose 2.24.4" "v-prefixed with a vendor suffix" SHIM_VERSION=v2.24.4-desktop.1
run pass "Compose 2.40.1" "a later 2.x minor" SHIM_VERSION=2.40.1
run fail "older than 2.24" "2.23.3 is too old" SHIM_VERSION=2.23.3
run fail "older than 2.24" "2.20.0 is too old" SHIM_VERSION=2.20.0
run fail "older than 2.24" "1.29.2 (v1) is too old" SHIM_VERSION=1.29.2
run fail "'docker compose version' failed" "the version command fails" SHIM_VERSION=
run fail "could not read a Compose version" "garbage version" SHIM_VERSION=dev-build

echo "published ports"
run pass "production publishes only $FIVE" "exactly the five edge ports" SHIM_JSON="$tmp/five.json"
run fail "[33000 33001 33005 33010 33012 33013]" "the Kratos admin port published again" SHIM_JSON="$tmp/extra-kratos.json"
run fail "[33000 33001 33005 33010 33012 33020]" "the raw-TCP port published again" SHIM_JSON="$tmp/extra-tcp.json"
run fail "[33000 33001 33005 33010 33012 33016]" "Mailpit's port (the dev profile leaked in)" SHIM_JSON="$tmp/extra-mailpit.json"
run fail "[33000 33001 33010 33012]" "an edge listener missing" SHIM_JSON="$tmp/missing.json"
run fail "[nothing]" "nothing published at all" SHIM_JSON="$tmp/none.json"
run fail "maps a random host port" "a mapping with no published port" SHIM_JSON="$tmp/random.json"
run fail "does not render" "the configuration does not render" SHIM_RENDER=fail
run fail "with no --profile flag" "a dev profile that only shows up WITHOUT the --profile flag (COMPOSE_PROFILES in the env file)" SHIM_JSON_NOPROFILE="$tmp/extra-mailpit.json"

echo "no docker"
total=$((total + 1))
bash_bin=$(command -v bash)
# A PATH with `dirname` (the guard's first line needs it) and nothing else, so `docker` is not found.
mkdir "$tmp/empty"
ln -s "$(command -v dirname)" "$tmp/empty/dirname"
out=$(PATH="$tmp/empty" "$bash_bin" "$GUARD" --env-file /dev/null 2>&1)
rc=$?
{ [ "$rc" -ne 0 ] && printf '%s\n' "$out" | grep -qF "docker is not installed"; } \
  || { note_fail "no docker on PATH — expected a clear refusal, got exit $rc: $out"; }

echo
if [ "$failed" -eq 0 ]; then
  echo "check-prod-ports.check: all $total assertions passed"
  exit 0
fi
echo "check-prod-ports.check: $failed of $total assertions FAILED" >&2
exit 1
