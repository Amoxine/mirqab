#!/usr/bin/env bash
# Guard: production publishes exactly the edge's five ports, and the Docker Compose rendering it
# understands the `!reset` tag the overlay depends on.
#
#   bash infra/scripts/check-prod-ports.sh                       # renders with built-in dummy secrets
#   bash infra/scripts/check-prod-ports.sh --env-file infra/.env # renders with the deployment's own env
#
# Why it exists. infra/docker-compose.prod.yml removes the development ports (Postgres, Redis, the
# Hydra, Kratos and Keto admin APIs, the raw-TCP 33020) with `ports: !reset []`. If a Compose that
# does not implement `!reset` merely IGNORES the tag, those resets silently do nothing and every one
# of those ports, including the unauthenticated Kratos admin API, is published again. That is a
# fail-OPEN, and it is unverified whether Compose 2.20-2.23 behaves that way, so this does not trust
# the version number alone: it asserts the version AND reads back what actually gets published.
#
# The check on the RENDERED output is the one that matters; the version check only turns a vague
# failure into a clear one. Run with the real env file it also catches a `COMPOSE_PROFILES=dev` that
# a laptop's infra/.env carried onto a server (that renders Mailpit's port 33016): install.sh writes
# that line into the development infra/.env, and a server's must never have it.
#
# deploy-staging.sh runs it before `up`. Wiring it into CI (.github/workflows/ci.yml, dummy env, no
# daemon needed) is the follow-up that stops an overlay edit from reaching a host unchecked.
set -euo pipefail
cd "$(dirname "$0")/../.."

EXPECTED="33000 33001 33005 33010 33012"
MIN_MAJOR=2
MIN_MINOR=24

env_file=''
while [ $# -gt 0 ]; do
  case "$1" in
    --env-file)
      env_file=${2:?--env-file needs a path}
      shift 2
      ;;
    *)
      echo "usage: check-prod-ports.sh [--env-file FILE]" >&2
      exit 2
      ;;
  esac
done

fail() {
  echo "check-prod-ports: FAIL  $*" >&2
  exit 1
}

# ── 1. Compose version ────────────────────────────────────────────────────────────────────────────
command -v docker >/dev/null 2>&1 || fail "docker is not installed or not on PATH"
version=$(docker compose version --short 2>/dev/null) || fail "'docker compose version' failed — is the Compose v2 plugin installed?"
version=${version#v}
major=${version%%.*}
rest=${version#*.}
minor=${rest%%.*}
minor=${minor%%[!0-9]*}
case "$major$minor" in
  '' | *[!0-9]*) fail "could not read a Compose version out of '$version'" ;;
esac
if [ "$major" -lt "$MIN_MAJOR" ] || { [ "$major" -eq "$MIN_MAJOR" ] && [ "$minor" -lt "$MIN_MINOR" ]; }; then
  fail "Docker Compose $version is older than $MIN_MAJOR.$MIN_MINOR, which the production overlay's '!reset' tag needs; an older one may ignore the tag and publish the development ports"
fi

# ── 2. Render and read back ───────────────────────────────────────────────────────────────────────
tmp=''
if [ -z "$env_file" ]; then
  tmp=$(mktemp)
  trap 'rm -f "$tmp"' EXIT
  # Every variable the two files require (`${VAR:?}`), with dummy values: this renders, it starts nothing.
  cat >"$tmp" <<'EOF'
DB_PASS=dummydbpass0123456789abcdef
JWT_SECRET=dummyjwt0123456789abcdef0123456789abcdef
TYK_WEBHOOK_RELAY_SECRET=dummyrelay0123456789abcdef0123456789
HYDRA_SECRETS_SYSTEM=dummyhydrasys0123456789abcdef0123456789
HYDRA_SECRETS_COOKIE=dummyhydracookie0123456789abcdef012345
KRATOS_SECRETS_DEFAULT=dummykratosdef0123456789abcdef012345
KRATOS_SECRETS_COOKIE=dummykratoscookie0123456789abcdef01
KRATOS_SECRETS_CIPHER=dummycipher0123456789abcdef0123
TYK_GW_SECRET=dummytyksecret0123456789abcdef0123456789
REDIS_PASSWORD=dummyredis0123456789abcdef0123456789abcd
PG_EXPORTER_PASSWORD=dummypgexp0123456789abcdef0123456789ab
EDGE_IMAGE=ghcr.io/example/repo/edge@sha256:0000000000000000000000000000000000000000000000000000000000000000
KRATOS_SMTP_URI=smtps://user:pass@smtp.example.test:465/
EOF
  env_file=$tmp
fi

# Rendered TWICE. `--profile multinode` is what deploy-staging.sh and the runbook pass, but an explicit
# `--profile` on the command line REPLACES COMPOSE_PROFILES from the env file (measured on Compose 5.1.4:
# with COMPOSE_PROFILES=dev in the file, `--profile multinode` renders no Mailpit and a bare run does).
# So the deployed command would hide a `COMPOSE_PROFILES=dev` copied from a laptop's infra/.env, and
# the first time someone runs the stack WITHOUT the flag, Mailpit and its port would appear. The
# flag-less render is that second run.
check_render() {
  label=$1
  shift
  err=$(mktemp)
  if ! json=$(docker compose --env-file "$env_file" -f infra/docker-compose.yml -f infra/docker-compose.prod.yml \
    "$@" config --format json 2>"$err"); then
    msg=$(head -n 3 "$err")
    rm -f "$err"
    fail "the production configuration ($label) does not render: $msg"
  fi
  rm -f "$err"

  # `grep -o` rather than a JSON tool: this runs on a deploy host with nothing but Docker and coreutils.
  # A port entry always has a numeric `"target"`; a published one also has a `"published"` string.
  # Counting both catches `ports: - "8080"` (a RANDOM host port), which has a target and no published.
  published=$(printf '%s' "$json" | grep -o '"published": *"[0-9]*"' | grep -o '[0-9]\+' | sort -n | tr '\n' ' ' | sed 's/ $//' || true)
  # `|| true` on both: grep -o exits 1 when nothing matches, and under pipefail + set -e that would end
  # the script silently, with no message, in exactly the "nothing is published" case.
  entries=$(printf '%s' "$json" | grep -o '"target": *[0-9]\+' | wc -l | tr -d ' ' || true)
  expected_count=$(printf '%s\n' $EXPECTED | wc -l | tr -d ' ')

  if [ "$published" != "$EXPECTED" ]; then
    fail "production ($label) would publish [${published:-nothing}] but only the edge's [$EXPECTED] are allowed. Anything extra is a development port the overlay should have reset, or a dev-profile service enabled by COMPOSE_PROFILES in the env file; anything missing is an edge listener that would not come up"
  fi
  if [ "$entries" != "$expected_count" ]; then
    fail "production ($label) renders $entries port mappings but only $expected_count are published with a number: one maps a random host port"
  fi
}

check_render "as deployed, --profile multinode" --profile multinode
check_render "with no --profile flag, so COMPOSE_PROFILES from the env file applies"

echo "check-prod-ports: ok  Compose $version, production publishes only $EXPECTED"
