#!/bin/sh
# Production preflight (WP29a). Entrypoint of the `prod-preflight` service in
# infra/docker-compose.prod.yml, which `api`, `web` and every gateway node depend on with
# `condition: service_completed_successfully` — so a non-zero exit here means the prod profile does
# not start, rather than starting with a default secret and a warning nobody reads.
#
# Runs on `redis:7-alpine` for one reason: it is already in the stack and carries both tools this
# needs — `redis-cli` for the unauthenticated-Redis probe and busybox `wget` for the Kratos login
# probe. No image to build, no package to install at boot.
#
# Every check runs even after one fails, and each prints its own line. A preflight that stops at the
# first problem turns "fix the deployment" into four boot-fix-boot cycles.
#
# Standalone (same checks, no compose):
#   docker run --rm --network <project>_open-gateway-network --network <project>_ory-internal \
#     -e NODE_ENV=production -e TYK_GW_SECRET=... -e REDIS_PASSWORD=... -e DB_PASS=... \
#     -e TYK_PMP_PUMPS_POSTGRES_META_CONNECTIONSTRING=... \
#     -v "$PWD/infra/scripts/prod-preflight.sh:/preflight.sh:ro" redis:7-alpine sh /preflight.sh
set -u

fail=0
bad() {
  echo "FAIL  $*" >&2
  fail=1
}
ok() { echo "ok    $*"; }

# A secret must be non-empty and contain no whitespace. Length alone is not enough: `${#VAR}`
# happily counts spaces, so a TYK_GW_SECRET of 40 spaces — which is what a truncated copy-paste or
# a trailing-whitespace .env line produces — passed every check this script made. Whitespace also
# rules out the multi-line case, where a value whose FIRST line is the committed default sails past
# a `case` comparing the whole string. Neither is an attack (these come from the operator's own
# .env) but both are silent, and a preflight that accepts 40 spaces as a gateway secret is
# decoration.
#
# Length-after-stripping, NOT a `case` glob listing the whitespace characters. The glob version was
# written first and was wrong in the most embarrassing way available: `*"$(printf '\n')"*` is
# `*""*`, because command substitution strips trailing newlines — and `*""*` matches EVERY string,
# so it rejected a perfectly good 64-character hex secret. It was caught only by testing a value
# that was supposed to PASS. `tr -d '[:space:]'` needs no quoting gymnastics and covers tab, CR and
# form feed as well as space and newline.
has_whitespace() {
  _stripped=$(printf '%s' "$1" | tr -d '[:space:]')
  [ "${#_stripped}" -ne "${#1}" ]
}

: "${NODE_ENV:=}"
: "${TYK_GW_SECRET:=}"
: "${REDIS_PASSWORD:=}"
: "${DB_PASS:=}"
: "${TYK_PMP_PUMPS_POSTGRES_META_CONNECTIONSTRING:=}"
: "${EDGE_IMAGE:=}"
: "${KRATOS_PUBLIC_URL:=http://kratos:4433}"
: "${DEFAULT_ADMIN_EMAIL:=admin@opengateway.io}"
: "${DEFAULT_ADMIN_PASSWORD:=Admin123!}"

echo "── prod preflight ─────────────────────────────────────────"

# ── 1. NODE_ENV ────────────────────────────────────────────────────────────────
# Not cosmetic: app.module.ts picks the throttler limit off this (100/min at production, 1000/min
# otherwise), so a prod stack left at `development` rate-limits ten times looser than intended.
if [ "$NODE_ENV" = "production" ]; then
  ok "NODE_ENV=production"
else
  bad "NODE_ENV is '${NODE_ENV:-unset}', not 'production' — the API would throttle at 1000/min instead of 100/min"
fi

# ── 2. Gateway shared secret ───────────────────────────────────────────────────
# `tyk-gateway-secret` is the committed fallback in docker-compose.yml. Anyone who has read this
# repository holds it, and it is the credential for the gateway's control API — which creates keys,
# rewrites API definitions and reads every tenant's config.
case "$TYK_GW_SECRET" in
  '') bad "TYK_GW_SECRET is unset — the compose default 'tyk-gateway-secret' would be used" ;;
  tyk-gateway-secret) bad "TYK_GW_SECRET is still the committed default 'tyk-gateway-secret'" ;;
  *)
    if has_whitespace "$TYK_GW_SECRET"; then
      bad "TYK_GW_SECRET contains whitespace — a padded or multi-line value is not a secret"
    elif [ "${#TYK_GW_SECRET}" -lt 32 ]; then
      bad "TYK_GW_SECRET is only ${#TYK_GW_SECRET} characters — use at least 32 (openssl rand -hex 32)"
    else
      ok "TYK_GW_SECRET set, ${#TYK_GW_SECRET} characters"
    fi
    ;;
esac

# ── 3. Redis password ──────────────────────────────────────────────────────────
# Two checks, because either alone is a lie: the variable can be set while the server was never
# told about it, and the server can reject us for a reason other than auth. The probe is what
# decides — an unauthenticated PING that SUCCEEDS means anything on this network can read every
# session key and quota counter in the stack.
if [ -z "$REDIS_PASSWORD" ]; then
  bad "REDIS_PASSWORD is unset — Redis holds every gateway key, session and quota counter"
elif has_whitespace "$REDIS_PASSWORD"; then
  bad "REDIS_PASSWORD contains whitespace — a padded or multi-line value is not a secret"
else
  ok "REDIS_PASSWORD set, ${#REDIS_PASSWORD} characters"
fi

probe=$(redis-cli -h "${REDIS_HOST:-redis}" -p "${REDIS_PORT:-6379}" --no-auth-warning PING 2>&1)
case "$probe" in
  PONG) bad "Redis answers PING with no password — it is unauthenticated" ;;
  *NOAUTH* | *'no password is set'*) ok "Redis refuses unauthenticated commands (NOAUTH)" ;;
  *)
    # Not a pass: an unreachable Redis proves nothing either way, and treating "cannot tell" as
    # "fine" is how a preflight becomes decoration.
    bad "could not determine whether Redis requires a password (got: $probe)"
    ;;
esac

# ── 4. Postgres password reaching the pump ─────────────────────────────────────
# pump.conf ships `password=` EMPTY on purpose — it is committed, so it must carry no secret. The
# real value arrives as this env override (docker-compose.yml's tyk-pump service). If the override
# is missing or still empty, the pump silently falls back to the file's empty password and analytics
# stops being written with no error the dashboard can show.
if [ -z "$DB_PASS" ]; then
  bad "DB_PASS is unset"
elif has_whitespace "$DB_PASS"; then
  bad "DB_PASS contains whitespace — it also goes into the pump's libpq connection string, where a space ENDS the value"
else
  ok "DB_PASS set, ${#DB_PASS} characters"
fi

if [ -z "$TYK_PMP_PUMPS_POSTGRES_META_CONNECTIONSTRING" ]; then
  bad "TYK_PMP_PUMPS_POSTGRES_META_CONNECTIONSTRING is unset — the pump would use pump.conf's empty password"
else
  # libpq keyword=value: the password runs to the next space, so an empty field matches nothing.
  pump_pw=$(echo "$TYK_PMP_PUMPS_POSTGRES_META_CONNECTIONSTRING" | sed -n 's/.*password=\([^ ]*\).*/\1/p')
  if [ -n "$pump_pw" ]; then
    ok "pump connection string carries a Postgres password"
  else
    bad "the pump connection string still carries an empty Postgres password"
  fi
fi

if [ -r /pump.conf ] && grep -qE '"connection_string": *"[^"]*password=[^ "]' /pump.conf; then
  bad "infra/pump/pump.conf has a password baked into connection_string — that file is committed"
fi

# ── 5. The edge image is digest-pinned ─────────────────────────────────────────
# The edge is the only SELF-COMPILED artifact in the stack (infra/edge/Dockerfile), so it is the
# only image whose contents are decided here rather than by an upstream publisher — and the one
# place where "the tag we deployed last week" and "the tag we deploy today" can differ with nothing
# in any diff to show it. A digest is content-addressed and cannot.
#
# A tag is rejected even when it looks specific: `:v1.2.3` is still mutable, and this check exists
# precisely for the case where someone repushed one.
#
# The digest has to be 64 HEX characters, and the length alone is not the check. This used to be a
# `case` glob of 64 `?`s, which accepted `@sha256:zzzz…z` as a valid pin (found by worker-3) — `?`
# matches any character, so it tested the shape and not the content. Strip every hex digit and
# require nothing to be left, the same way the whitespace check above works: no 64-way glob to
# miscount and no dependency on a regex engine this `sh` may not have.
case "$EDGE_IMAGE" in
  '')
    bad "EDGE_IMAGE is unset — the prod overlay needs a digest-pinned edge image (see infra/edge/README.md)"
    ;;
  *@sha256:*)
    _digest=${EDGE_IMAGE##*@sha256:}
    _nonhex=$(printf '%s' "$_digest" | tr -d '0-9a-f')
    if [ "${#_digest}" -eq 64 ] && [ -z "$_nonhex" ]; then
      ok "EDGE_IMAGE is digest-pinned"
    else
      bad "EDGE_IMAGE has a malformed sha256 digest (need 64 hex characters, got ${#_digest}): $EDGE_IMAGE"
    fi
    ;;
  *)
    bad "EDGE_IMAGE '$EDGE_IMAGE' is a mutable tag — pin it by digest (ghcr.io/<owner>/<repo>/edge@sha256:...)"
    ;;
esac

# ── 6. The seeded default administrator ────────────────────────────────────────
# Behavioural, not a grep, and deliberately so. The seed's bcrypt hash is COPIED into Kratos as
# `hashed_password` (README, migrate-users-to-kratos.ts), so the credential that actually signs in
# lives in Kratos and a grep of the `users` table would both miss a Kratos-only change and flag a
# Postgres row that can no longer log in anywhere. Asking Kratos to log in is the same question an
# attacker asks, and the answer needs no bcrypt in this image.
#
# A SUCCESSFUL login is the failure. The session this creates is revoked immediately below.
flow=$(wget -qO- --header='Accept: application/json' "$KRATOS_PUBLIC_URL/self-service/login/api" 2>/dev/null)
flow_id=$(echo "$flow" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')
if [ -z "$flow_id" ]; then
  bad "could not start a Kratos login flow at $KRATOS_PUBLIC_URL — cannot prove the default admin is gone"
else
  login=$(wget -qO- --header='Content-Type: application/json' --header='Accept: application/json' \
    --post-data "{\"method\":\"password\",\"identifier\":\"$DEFAULT_ADMIN_EMAIL\",\"password\":\"$DEFAULT_ADMIN_PASSWORD\"}" \
    "$KRATOS_PUBLIC_URL/self-service/login?flow=$flow_id" 2>/dev/null)
  token=$(echo "$login" | sed -n 's/^{"session_token":"\([^"]*\)".*/\1/p')
  if [ -n "$token" ]; then
    bad "$DEFAULT_ADMIN_EMAIL still signs in with the seeded password — change it before serving traffic"
    # Do not leave the session we just opened behind. Best effort: the finding stands either way.
    wget -qO- --header='Content-Type: application/json' \
      --post-data "{\"session_token\":\"$token\"}" \
      "$KRATOS_PUBLIC_URL/self-service/logout/api" >/dev/null 2>&1 || true
  else
    ok "$DEFAULT_ADMIN_EMAIL does not sign in with the seeded password"
  fi
fi

echo "───────────────────────────────────────────────────────────"
if [ "$fail" -ne 0 ]; then
  echo "prod preflight FAILED — the stack will not start. Fix the lines above." >&2
  exit 1
fi
echo "prod preflight passed"
