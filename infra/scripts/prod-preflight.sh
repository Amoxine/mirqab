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
#     -e TYK_PMP_PUMPS_POSTGRES_META_CONNECTIONSTRING=... -e PG_EXPORTER_PASSWORD=... \
#     -e KRATOS_SMTP_URI=... -e KRATOS_COOKIE_SECURE=true -e EDGE_IMAGE=... \
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

# DB_PASS, REDIS_PASSWORD and PG_EXPORTER_PASSWORD are spliced RAW into URLs and command lines:
# `redis://:PASSWORD@redis:6379` (api), `postgresql://user:PASSWORD@postgres/...` (api, web, the
# Ory DSNs), and Redis's own `--requirepass PASSWORD`. A `@`, `/`, `:`, `#`, `%` or `?` in any of
# them does not fail anywhere obvious, it rewrites the URL: the host becomes whatever follows the
# first `@`. So they are held to the unreserved URL characters, which `openssl rand -hex` output
# satisfies. The message never says which character: a rejected secret is still a secret.
only_url_safe() {
  _rest=$(printf '%s' "$1" | tr -d 'A-Za-z0-9._~-')
  [ -z "$_rest" ]
}

: "${NODE_ENV:=}"
: "${TYK_GW_SECRET:=}"
: "${REDIS_PASSWORD:=}"
: "${DB_PASS:=}"
: "${TYK_PMP_PUMPS_POSTGRES_META_CONNECTIONSTRING:=}"
: "${EDGE_IMAGE:=}"
: "${PG_EXPORTER_PASSWORD:=}"
: "${KRATOS_SMTP_URI:=}"
: "${KRATOS_COOKIE_SECURE:=}"
: "${COOKIE_SECURE:=}"
# Seconds a wget may wait for Kratos. Without it busybox waits for its own (very long) default, and a
# Kratos that accepts the connection and never answers would hang `up` here for good.
: "${WGET_TIMEOUT:=10}"
: "${KRATOS_PUBLIC_URL:=http://kratos:4433}"
: "${DEFAULT_ADMIN_EMAIL:=admin@opengateway.io}"
: "${DEFAULT_ADMIN_PASSWORD:=Admin123!}"

echo "── prod preflight ─────────────────────────────────────────"

# ── 1. NODE_ENV ────────────────────────────────────────────────────────────────
# Not cosmetic: app.module.ts picks the throttler limit off this (100/min at production, 1000/min
# otherwise), so a prod stack left at `development` rate-limits ten times looser than intended.
#
# This reads the REAL value only because the overlay feeds the preflight, api and web from one YAML
# anchor (`x-node-env` in docker-compose.prod.yml); with a literal on each service the check could
# never fail. It therefore catches an edit to that anchor, not an edit that replaces the alias on
# one service with a literal.
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
elif ! only_url_safe "$REDIS_PASSWORD"; then
  bad "REDIS_PASSWORD has a character outside A-Z a-z 0-9 . _ ~ - — it is spliced raw into redis:// URLs and Redis's command line, where it would change the URL; use openssl rand -hex 32"
elif [ "${#REDIS_PASSWORD}" -lt 32 ]; then
  bad "REDIS_PASSWORD is only ${#REDIS_PASSWORD} characters — use at least 32 (openssl rand -hex 32); every gateway key, session and quota counter sits behind it"
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

# The positive half. Refusing strangers is only half of "Redis is configured right": the gateway
# nodes, the api and the pump all authenticate with this exact value, so a Redis that demands a
# DIFFERENT password (a volume or a `command:` from an earlier deploy) passes the check above and
# then fails every client. REDISCLI_AUTH rather than `-a`, so the password is not in the process list.
if [ -n "$REDIS_PASSWORD" ]; then
  authed=$(REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli -h "${REDIS_HOST:-redis}" -p "${REDIS_PORT:-6379}" --no-auth-warning PING 2>&1)
  case "$authed" in
    PONG) ok "Redis accepts REDIS_PASSWORD" ;;
    *) bad "Redis does not accept REDIS_PASSWORD (got: $authed) — every client authenticates with it" ;;
  esac
fi

# ── 4. Postgres password reaching the pump ─────────────────────────────────────
# pump.conf ships `password=` EMPTY on purpose — it is committed, so it must carry no secret. The
# real value arrives as this env override (docker-compose.yml's tyk-pump service). If the override
# is missing or still empty, the pump silently falls back to the file's empty password and analytics
# stops being written with no error the dashboard can show.
if [ -z "$DB_PASS" ]; then
  bad "DB_PASS is unset"
elif has_whitespace "$DB_PASS"; then
  bad "DB_PASS contains whitespace — it also goes into the pump's libpq connection string, where a space ENDS the value"
elif ! only_url_safe "$DB_PASS"; then
  bad "DB_PASS has a character outside A-Z a-z 0-9 . _ ~ - — it is spliced raw into postgresql:// URLs and the pump's connection string, where it would change them; use openssl rand -hex 16"
elif [ "${#DB_PASS}" -lt 16 ]; then
  bad "DB_PASS is only ${#DB_PASS} characters — use at least 16 (openssl rand -hex 16 gives 32)"
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
    if [ "${#_digest}" -ne 64 ]; then
      bad "EDGE_IMAGE's sha256 digest is ${#_digest} characters, need 64: $EDGE_IMAGE"
    elif [ -n "$_nonhex" ]; then
      # Saying "got 64" for 64 non-hex characters was true and useless — it named the one thing
      # that was right about the value.
      bad "EDGE_IMAGE's sha256 digest is 64 characters but not hexadecimal: $EDGE_IMAGE"
    else
      ok "EDGE_IMAGE is digest-pinned"
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
# A SUCCESSFUL login is the failure, and so is every outcome that is not an explicit rejection.
#
# This check used to pass vacuously, which is the worst thing a gate can do: it matched the token
# only when `session_token` was the FIRST key of the response, and treated any answer without one —
# an empty body, a 5xx, a refused connection, a body broken by a quote in the password — as "the
# login does not work". Busybox wget prints NOTHING on stdout for a 4xx or 5xx, so all of those
# looked identical to a correct deployment. Now the ONLY passing outcome is Kratos rejecting the
# credentials: HTTP 400, which busybox wget reports as a NON-ZERO exit status (1 on busybox 1.37) and
# `wget: server returned error: HTTP/1.1 400 Bad Request` as the first stderr line, matched at the START of
# that line so a 502 whose reason text merely says "400" cannot pass; a session token ANYWHERE in the body fails;
# everything else is "inconclusive", which is a failure, because a preflight that cannot tell has
# not proved anything. A fresh deployment with no such identity gets the same 400 (Kratos does not
# reveal whether an identifier exists), so the first deploy passes.
#
# The wget behaviour above was MEASURED on busybox v1.37.0 in redis:7-alpine, against a local responder: 400
# gives exit 1 and the stderr line quoted; 200 gives exit 0 and the body; a 5xx, a refused connection and a
# timeout each give exit 1 with their own text. infra/scripts/prod-preflight.check.sh pins the decision
# against shims that emulate those answers.
#
# What a 400 does NOT prove: wget throws the response BODY away on a 4xx, so this cannot tell "wrong
# credentials" (Kratos' own message) from another 400 (a malformed body, a flow in a state that rejects the
# method). The body is built from escaped values and a fresh flow, so the realistic cause is the credentials
# being refused, but that is inference, not observation. Reading the body would take a raw HTTP exchange
# over `nc` (present in the image) and Kratos' message id, which could not be checked without a running
# Kratos; it is left out rather than added unverified.
#
# The session this opens when it does succeed is revoked immediately below.
json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
json_safe() {
  _printable=$(printf '%s' "$1" | tr -d '[:cntrl:]')
  [ "${#_printable}" -eq "${#1}" ]
}

errf=$(mktemp 2>/dev/null || echo "/tmp/preflight-wget.$$")
trap 'rm -f "$errf"' EXIT

if ! json_safe "$DEFAULT_ADMIN_EMAIL$DEFAULT_ADMIN_PASSWORD"; then
  bad "inconclusive: DEFAULT_ADMIN_EMAIL or DEFAULT_ADMIN_PASSWORD holds a control character, so the login probe cannot be built safely"
else
  flow=$(wget -qO- -T "$WGET_TIMEOUT" --header='Accept: application/json' "$KRATOS_PUBLIC_URL/self-service/login/api" 2>"$errf")
  flow_rc=$?
  flow_id=$(printf '%s' "$flow" | sed -n 's/^{"id":"\([^"]*\)".*/\1/p')
  if [ -z "$flow_id" ]; then
    bad "inconclusive: could not start a Kratos login flow at $KRATOS_PUBLIC_URL (wget exit $flow_rc: $(head -n 1 "$errf")) — cannot prove the default admin is gone"
  else
    body="{\"method\":\"password\",\"identifier\":\"$(json_escape "$DEFAULT_ADMIN_EMAIL")\",\"password\":\"$(json_escape "$DEFAULT_ADMIN_PASSWORD")\"}"
    login=$(wget -qO- -T "$WGET_TIMEOUT" --header='Content-Type: application/json' --header='Accept: application/json' \
      --post-data "$body" \
      "$KRATOS_PUBLIC_URL/self-service/login?flow=$flow_id" 2>"$errf")
    login_rc=$?
    login_err=$(head -n 1 "$errf")
    case "$login" in
      *'"session_token"'*)
        bad "$DEFAULT_ADMIN_EMAIL still signs in with the seeded password — change it before serving traffic"
        # Do not leave the session we just opened behind. Best effort: the finding stands either way.
        token=$(printf '%s' "$login" | sed -n 's/.*"session_token"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')
        if [ -n "$token" ]; then
          wget -qO- -T "$WGET_TIMEOUT" --header='Content-Type: application/json' \
            --post-data "{\"session_token\":\"$(json_escape "$token")\"}" \
            "$KRATOS_PUBLIC_URL/self-service/logout/api" >/dev/null 2>&1 || true
        fi
        ;;
      *)
        case "$login_err" in
          'wget: server returned error: HTTP/1.'[01]' 400' | 'wget: server returned error: HTTP/1.'[01]' 400 '*)
            if [ "$login_rc" -ne 0 ]; then
              ok "$DEFAULT_ADMIN_EMAIL is rejected by Kratos with the seeded password (HTTP 400)"
            else
              bad "inconclusive: the login probe reported HTTP 400 but wget exited 0 — not a rejection I can vouch for"
            fi
            ;;
          *)
            bad "inconclusive: the default-admin login probe got neither a session nor an explicit rejection (wget exit $login_rc: ${login_err:-no output}) — cannot prove the default admin is gone"
            ;;
        esac
        ;;
    esac
  fi
fi

# ── 7. Postgres exporter password (OG-OBS-02) ──────────────────────────────────
# The og_monitor role postgres-exporter logs in as (infra/postgres/monitoring-role.sql). The prod
# overlay's `:?` already refuses an unset value, so what this adds is the shape: a pasted or padded
# value is set but not a secret, and `install.sh` mints 64 hex characters, so anything under 32 was
# typed by hand. The role is read-only (pg_monitor), but it still reads every database's activity,
# including query text in pg_stat_activity.
if [ -z "$PG_EXPORTER_PASSWORD" ]; then
  bad "PG_EXPORTER_PASSWORD is unset — postgres-exporter's og_monitor role would have no password"
elif has_whitespace "$PG_EXPORTER_PASSWORD"; then
  bad "PG_EXPORTER_PASSWORD contains whitespace — a padded or multi-line value is not a secret"
elif ! only_url_safe "$PG_EXPORTER_PASSWORD"; then
  bad "PG_EXPORTER_PASSWORD has a character outside A-Z a-z 0-9 . _ ~ - — it passes through compose interpolation, a shell command and the exporter's connection string, and openssl rand -hex 32 output needs none of that care; use it"
elif [ "${#PG_EXPORTER_PASSWORD}" -lt 32 ]; then
  bad "PG_EXPORTER_PASSWORD is only ${#PG_EXPORTER_PASSWORD} characters — use at least 32 (openssl rand -hex 32)"
else
  ok "PG_EXPORTER_PASSWORD set, ${#PG_EXPORTER_PASSWORD} characters"
fi

# ── 8. Kratos SMTP (the base file's default is the dev-only Mailpit) ───────────
# Without a deliverable SMTP server Kratos still starts: it queues every recovery and verification
# code in courier_messages and never sends one, so the failure shows up as users who cannot reset a
# password, not as a boot error. The base file defaults to `smtp://mailpit:1025`, a container this
# overlay does not start, which is exactly the value an operator who forgot to set this would get.
#
# The URI usually carries credentials (smtps://user:pass@host), so no line below prints it — only
# the host, and only after it has been checked to BE a host (see the shape test).
#
# Kratos reads this with Go's net/url and the TLS flags with strconv.ParseBool, and this parser is meant
# to agree with them on every reading that would otherwise slip through:
#   - lowercase first (hostnames are case-insensitive; `LOCALHOST` is the same machine);
#   - the authority ends at the first `/`, `?` or `#` (`smtp://localhost:25#@smtp.example.test` is
#     host `localhost` to Go, whatever follows the `#`);
#   - the host is what follows the LAST `@` of the authority (a password may hold a raw `@`);
#   - host:port must be `host`, `host:digits` or a bracketed IPv6 literal, optionally `:digits`. Anything
#     else is REJECTED, and that is what catches an unencoded `/`, `?` or `#` in the username or password
#     (common in generated SES and SendGrid secrets): the authority is cut inside the password, so what
#     is left is not a host:port, and without this test the username would be printed as the "host";
#   - TLS: `skip_ssl_verify` and `disable_starttls` may appear only with a value ParseBool reads as false
#     (0, f, F, false, FALSE, False). ParseBool also reads t, T, 1, true, TRUE and True as true, and
#     rejects everything else; an unreadable value is refused rather than guessed at. Keys are matched
#     case-insensitively, `;` is treated like `&`, and a `%` anywhere in the query is refused outright so
#     `skip%5Fssl_verify=true` or `skip_ssl_verify=%31` cannot hide the setting from a text match.
#
# What this does NOT do. It does not test that the host answers: nc is in the redis:7-alpine image, but a
# reachability probe cannot tell "no route from the preflight container" from "the provider is down", and
# delivery is proved end to end by the mail step in docs/go-live.md. And the loopback test is a list of
# spellings, not a resolver. Handled: localhost and its dotted/`.localhost` forms, 127.x.x.x, 0, 0.0.0.0, ::,
# ::1, ::ffff:127.x, a bare decimal number (2130706433) and 0x...; NOT handled: octal or mixed IPv4
# (`0177.0.0.1`), other IPv6 spellings of loopback (`0:0:0:0:0:0:0:1`, `::ffff:7f00:1`), IPv6 zone ids, and
# any hostname that merely resolves to loopback (`localtest.me`, an /etc/hosts alias).
smtp_lc=$(printf '%s' "$KRATOS_SMTP_URI" | tr 'A-Z' 'a-z')
smtp_rest=${smtp_lc#*://}
smtp_auth=${smtp_rest%%[/?#]*}
smtp_hostport=${smtp_auth##*@}
# The query is read from the ORIGINAL text: ParseBool is case-sensitive, so `False` and `fAlse` differ.
# `tr` keeps lengths, so the authority's length indexes both copies.
smtp_orig_rest=${KRATOS_SMTP_URI#*://}
smtp_orig_after=$(printf '%s' "$smtp_orig_rest" | cut -c "$((${#smtp_auth} + 1))-")
smtp_nofrag=${smtp_orig_after%%#*}
smtp_query=''
case "$smtp_nofrag" in *\?*) smtp_query=${smtp_nofrag#*\?} ;; esac

smtp_shape_ok=1
smtp_host=''
case "$smtp_hostport" in
  \[*\] | \[*\]:*)
    smtp_host=${smtp_hostport%%]*}
    smtp_host=${smtp_host#\[}
    smtp_port_part=${smtp_hostport#*]}
    case "$smtp_port_part" in
      '') ;;
      :*) case "${smtp_port_part#:}" in '' | *[!0-9]*) smtp_shape_ok=0 ;; esac ;;
      *) smtp_shape_ok=0 ;;
    esac
    case "$smtp_host" in '' | *[!0-9a-f:.]*) smtp_shape_ok=0 ;; esac
    ;;
  *:*)
    smtp_host=${smtp_hostport%%:*}
    case "${smtp_hostport#*:}" in '' | *[!0-9]*) smtp_shape_ok=0 ;; esac
    case "$smtp_host" in *[!a-z0-9._-]*) smtp_shape_ok=0 ;; esac
    ;;
  *)
    smtp_host=$smtp_hostport
    case "$smtp_host" in *[!a-z0-9._-]*) smtp_shape_ok=0 ;; esac
    ;;
esac

# 0 = every TLS-related key in the query is explicitly false, 1 = one is true, unreadable or encoded.
smtp_tls_weak=0
case "$smtp_query" in
  *%*) smtp_tls_weak=1 ;;
  *)
    smtp_old_ifs=$IFS
    IFS='&'
    set -f
    for smtp_pair in $(printf '%s' "$smtp_query" | tr ';' '&'); do
      smtp_key=$(printf '%s' "${smtp_pair%%=*}" | tr 'A-Z' 'a-z')
      case "$smtp_pair" in *=*) smtp_val=${smtp_pair#*=} ;; *) smtp_val='' ;; esac
      case "$smtp_key" in
        skip_ssl_verify | disable_starttls)
          case "$smtp_val" in 0 | f | F | false | FALSE | False) ;; *) smtp_tls_weak=1 ;; esac
          ;;
      esac
    done
    set +f
    IFS=$smtp_old_ifs
    ;;
esac

case "$smtp_lc" in
  '')
    bad "KRATOS_SMTP_URI is unset — Kratos would queue recovery and verification mail and never deliver it"
    ;;
  smtp://* | smtps://*)
    if has_whitespace "$KRATOS_SMTP_URI"; then
      bad "KRATOS_SMTP_URI contains whitespace — a padded or multi-line value is not a URI"
    elif [ "$smtp_shape_ok" -ne 1 ]; then
      bad "KRATOS_SMTP_URI's address is not host, host:port or [ipv6]:port — an unencoded / ? # or @ in the username or password cuts it short; percent-encode them (/ as %2F, ? as %3F, # as %23, @ as %40, : as %3A) or pick a password without them"
    else
      case "$smtp_host" in
        '' | localhost | localhost. | *.localhost | ip6-localhost | ip6-loopback | 127.* | 0 | 0.0.0.0 | :: | ::1 | ::ffff:127.* | 0x*)
          bad "KRATOS_SMTP_URI host '$smtp_host' is empty, loopback or unspecified — inside this stack that is the container itself, and nothing there accepts mail"
          ;;
        mailpit | mailpit.*)
          bad "KRATOS_SMTP_URI points at the dev-only Mailpit (host '$smtp_host') — no such container runs in production, so no mail would be delivered"
          ;;
        *)
          case "$smtp_host" in
            *[!0-9]*)
              if [ "$smtp_tls_weak" -ne 0 ]; then
                bad "KRATOS_SMTP_URI has skip_ssl_verify or disable_starttls set to something other than an explicit false (0, f, F, false, FALSE, False), or a '%' in its query — that is the dev Mailpit setting; with a real host the credentials and every recovery code would cross the network unprotected or unverified"
              else
                ok "KRATOS_SMTP_URI set (host $smtp_host)"
              fi
              ;;
            *)
              bad "KRATOS_SMTP_URI host '$smtp_host' is a bare number, which is an IPv4 address written in decimal (2130706433 is 127.0.0.1) — use a hostname"
              ;;
          esac
          ;;
      esac
    fi
    ;;
  *)
    bad "KRATOS_SMTP_URI is not an smtp:// or smtps:// URI"
    ;;
esac

# ── 9. Kratos session cookie `Secure` ──────────────────────────────────────────
# The overlay passes KRATOS_COOKIE_SECURE (default true) to Kratos as SESSION_COOKIE_SECURE; the
# base file defaults it to false because the stack used to be plain HTTP, and `serve --dev` is
# already relaxing other things. Without `Secure`, the browser also attaches the Kratos session
# cookie to PLAIN-HTTP requests to the same hostname (cookies are not scoped by port), so anyone who
# can make the browser issue one — a link, a downgrade on the network — receives a live session.
# The edge serves only HTTPS, so there is no reason for the cookie to ever travel without it.
case "$KRATOS_COOKIE_SECURE" in
  true) ok "KRATOS_COOKIE_SECURE=true: the Kratos session cookie is Secure" ;;
  *) bad "KRATOS_COOKIE_SECURE is '${KRATOS_COOKIE_SECURE:-unset}', not 'true' — the Kratos session cookie would be sent over plain HTTP too" ;;
esac

# ── 10. Dashboard and API session cookies `Secure` ─────────────────────────────
# apps/web sets the dashboard's session cookies (mq_access_token, mq_refresh_token) and apps/api reads the
# same switch. COOKIE_SECURE overrides NODE_ENV "in either direction" (apps/web/src/lib/oauth-cookies.ts,
# apps/api's parseCookieSecure), so `COOKIE_SECURE=false` in infra/.env turns the flag OFF even under
# NODE_ENV=production, and nothing else here would notice. The base file defaults it to true; this is the
# gate on an operator overriding that.
case "$COOKIE_SECURE" in
  true) ok "COOKIE_SECURE=true: the dashboard's session cookies are Secure" ;;
  *) bad "COOKIE_SECURE is '${COOKIE_SECURE:-unset}', not 'true' — the dashboard's session cookies would be sent over plain HTTP too, whatever NODE_ENV says" ;;
esac

echo "───────────────────────────────────────────────────────────"
if [ "$fail" -ne 0 ]; then
  echo "prod preflight FAILED — the stack will not start. Fix the lines above." >&2
  exit 1
fi
echo "prod preflight passed"
