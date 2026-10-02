#!/bin/sh
# Tests infra/scripts/prod-preflight.sh by RUNNING it, with fake `wget` and `redis-cli` on PATH.
#
#   sh infra/scripts/prod-preflight.check.sh            # exit 0 = every case behaved
#   PREFLIGHT=/path/to/mutated.sh sh infra/scripts/prod-preflight.check.sh   # prove a case can fail
#
# A preflight is a gate, and a gate nobody has seen fail is a guess. Each case starts from a
# baseline where every check passes, changes ONE thing, and asserts the exact line the preflight
# prints and its exit status — the PASS cases are what show a check is not simply refusing everything.
#
# What the shims are. `wget` and `redis-cli` are replaced by scripts that emulate what the preflight
# depends on. For wget that was MEASURED on busybox v1.37.0 in redis:7-alpine, against a local responder:
# a 4xx or 5xx exits 1 (not 8) with `wget: server returned error: HTTP/1.1 400 Bad Request` as the first
# stderr line and nothing on stdout; a refused connection exits 1 with `wget: can't connect to remote host
# (...): Connection refused`; a server that accepts and never answers hangs forever unless `-T N` is given,
# and with it exits 1 after N seconds with `wget: download timed out`. redis-cli prints NOAUTH to an
# unauthenticated PING and PONG to a correct password.
#
# This file runs under the host's `sh` (bash in POSIX mode here) unless you run it in the image the
# preflight really uses, which also works and is how it was last checked:
#   docker run --rm --network none -v "$PWD/infra/scripts:/s:ro" redis:7-alpine sh /s/prod-preflight.check.sh
#
# No reachability probe for the SMTP host exists, and so none is tested: delivery is proved by the mail
# step in docs/go-live.md instead.
set -u

here=$(cd "$(dirname "$0")" && pwd)
PREFLIGHT=${PREFLIGHT:-$here/prod-preflight.sh}
[ -r "$PREFLIGHT" ] || { echo "no preflight at $PREFLIGHT" >&2; exit 2; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
shim=$tmp/bin
log=$tmp/log
mkdir "$shim" "$log"

# ── shims ──────────────────────────────────────────────────────────────────────────────────────────
cat >"$shim/redis-cli" <<'EOF'
#!/bin/sh
# SHIM_REDIS: protected (default) | open | down.  SHIM_REDIS_PW is the password the fake server wants.
case "${SHIM_REDIS:-protected}" in
  open) echo PONG ;;
  down) echo "Could not connect to Redis at redis:6379: Connection refused" ;;
  *)
    if [ -z "${REDISCLI_AUTH:-}" ]; then echo "NOAUTH Authentication required."
    elif [ "$REDISCLI_AUTH" = "${SHIM_REDIS_PW:-}" ]; then echo PONG
    else echo "(error) WRONGPASS invalid username-password pair or user is disabled."; fi ;;
esac
EOF
cat >"$shim/wget" <<'EOF'
#!/bin/sh
# Emulates busybox v1.37 wget as measured (see the header of the test).
# SHIM_FLOW (flow init): ok (default) | down | empty | hang.
# SHIM_LOGIN (login submit): 400 (default) | token-first | token-later | 500 | 502-400text | refused | empty |
#   400-rc0 | hang.
# `hang` = a server that accepts and never answers: sleeps for the -T value, then fails "download timed out";
# with NO -T it sleeps 600s, which the test's `timeout` turns into a failed assertion.
url=''; post=''; tflag=''
echo "$*" >>"$SHIM_LOG/args"
while [ $# -gt 0 ]; do
  case "$1" in
    --post-data) post=$2; shift ;;
    -T) tflag=$2; shift ;;
    -qO- | --header=*) ;;
    *) url=$1 ;;
  esac
  shift
done
hang() {
  if [ -n "$tflag" ]; then sleep "$tflag"; echo "wget: download timed out" >&2; exit 1; fi
  sleep 600
}
case "$url" in
  */self-service/login/api)
    case "${SHIM_FLOW:-ok}" in
      ok) printf '%s' '{"id":"flow-1234","type":"api","ui":{}}' ;;
      down) echo "wget: can't connect to remote host (172.18.0.9): Connection refused" >&2; exit 1 ;;
      hang) hang ;;
      empty) : ;;
    esac ;;
  */self-service/login\?flow=*)
    printf '%s' "$post" >"$SHIM_LOG/post.last"
    case "${SHIM_LOGIN:-400}" in
      token-first) printf '%s' '{"session_token":"tok-abc","session":{"id":"s1"}}' ;;
      token-later) printf '%s' '{"session":{"id":"s1"},"session_token":"tok-abc"}' ;;
      400) echo "wget: server returned error: HTTP/1.1 400 Bad Request" >&2; exit 1 ;;
      500) echo "wget: server returned error: HTTP/1.1 500 Internal Server Error" >&2; exit 1 ;;
      502-400text) echo "wget: server returned error: HTTP/1.1 502 upstream replied 400" >&2; exit 1 ;;
      400-rc0) echo "wget: server returned error: HTTP/1.1 400 Bad Request" >&2; exit 0 ;;
      refused) echo "wget: can't connect to remote host (172.18.0.9): Connection refused" >&2; exit 1 ;;
      hang) hang ;;
      empty) : ;;
    esac ;;
  */self-service/logout/api) echo "logout $post" >>"$SHIM_LOG/calls" ;;
esac
EOF
chmod +x "$shim/redis-cli" "$shim/wget"

# ── baseline: every check passes ──────────────────────────────────────────────────────────────────
baseline() {
  export NODE_ENV=production
  export TYK_GW_SECRET=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
  export REDIS_PASSWORD=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
  export SHIM_REDIS_PW=$REDIS_PASSWORD
  export DB_PASS=cccccccccccccccccccccccccccccccc
  export TYK_PMP_PUMPS_POSTGRES_META_CONNECTIONSTRING="host=postgres port=5432 user=opengateway password=$DB_PASS dbname=opengateway sslmode=disable"
  export PG_EXPORTER_PASSWORD=dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd
  export EDGE_IMAGE=ghcr.io/example/repo/edge@sha256:0000000000000000000000000000000000000000000000000000000000000000
  export KRATOS_SMTP_URI='smtps://u:p@smtp.example.test:465/'
  export KRATOS_COOKIE_SECURE=true
  export COOKIE_SECURE=true
  export SHIM_LOG=$log
}

TIMEOUT_BIN=$(command -v timeout || true)
total=0
failed=0
note_fail() { failed=$((failed + 1)); echo "  CASE FAILED: $*"; }

# run <pass|fail> <fixed text of the expected line, after its ok/FAIL prefix> <label> [VAR=value | -u:VAR]...
# pass: the line is printed with `ok` AND the whole preflight exits 0 (the baseline passes everything else).
# fail: the line is printed with `FAIL` AND the preflight exits 1.
run() {
  want=$1 text=$2 label=$3
  shift 3
  total=$((total + 1))
  : >"$log/post.last"
  : >"$log/calls"
  : >"$log/args"
  out=$(
    baseline
    for a in "$@"; do
      case "$a" in
        -u:*) unset "${a#-u:}" ;;
        *) export "$a" ;;
      esac
    done
    # `timeout` (coreutils and busybox both have it) turns a preflight that does not bound its wget calls
    # into rc 124 instead of a hung test run; where it is missing the hang cases simply cannot fail fast.
    PATH="$shim:$PATH" WGET_TIMEOUT=${WGET_TIMEOUT:-1} ${TIMEOUT_BIN:+$TIMEOUT_BIN 60} sh "$PREFLIGHT" 2>&1
  )
  rc=$?
  last_out=$out
  if [ "$want" = pass ]; then
    printf '%s\n' "$out" | grep -qF -- "ok    $text" && [ "$rc" -eq 0 ] \
      || { note_fail "$label — expected 'ok    $text' and exit 0, got exit $rc"; printf '%s\n' "$out" | sed 's/^/      | /'; }
  else
    printf '%s\n' "$out" | grep -qF -- "FAIL  $text" && [ "$rc" -eq 1 ] \
      || { note_fail "$label — expected 'FAIL  $text' and exit 1, got exit $rc"; printf '%s\n' "$out" | sed 's/^/      | /'; }
  fi
}

# check_true <label> <command...>: one more assertion about state a run() left behind.
check_true() {
  total=$((total + 1))
  label=$1
  shift
  "$@" || note_fail "$label"
}

# no_leak <secret>: the output of the LAST run() must not contain it.
no_leak() {
  total=$((total + 1))
  if printf '%s\n' "$last_out" | grep -qF -- "$1"; then note_fail "output leaked a secret value ($2)"; fi
}

echo "baseline"
run pass "NODE_ENV=production" "baseline: every check passes and the exit status is 0"
check_true "baseline prints its verdict line" sh -c 'printf "%s\n" "$1" | grep -qF "prod preflight passed"' _ "$last_out"

echo "check 1: NODE_ENV"
run fail "NODE_ENV is 'development'" "development" NODE_ENV=development
run fail "NODE_ENV is 'Production'" "capitalised is not production" NODE_ENV=Production
run fail "NODE_ENV is 'unset'" "unset" -u:NODE_ENV

echo "check 3: Redis — refuses strangers, accepts the real password, password shape"
run pass "Redis refuses unauthenticated commands (NOAUTH)" "protected redis refuses strangers"
run pass "Redis accepts REDIS_PASSWORD" "protected redis accepts the configured password"
run fail "Redis answers PING with no password" "open redis" SHIM_REDIS=open
run fail "Redis does not accept REDIS_PASSWORD" "server wants a different password" SHIM_REDIS_PW=somethingelse
run fail "could not determine whether Redis requires a password" "redis unreachable" SHIM_REDIS=down
run fail "REDIS_PASSWORD is unset" "unset" REDIS_PASSWORD=
run fail "REDIS_PASSWORD has a character outside" "'@' in the password" 'REDIS_PASSWORD=abcdefgh@ijklmnop/qrstuvwx' 'SHIM_REDIS_PW=abcdefgh@ijklmnop/qrstuvwx'
no_leak "ijklmnop" "REDIS_PASSWORD with @"
run fail "REDIS_PASSWORD has a character outside" "'%' in the password" 'REDIS_PASSWORD=abc%40def'
run pass "REDIS_PASSWORD set" "dots, tildes and dashes are allowed (32 characters)" 'REDIS_PASSWORD=Ab.c_d~e-f1234567890Ab.c_d~e-f12' 'SHIM_REDIS_PW=Ab.c_d~e-f1234567890Ab.c_d~e-f12'
run fail "REDIS_PASSWORD is only 31 characters" "31 characters is one short" 'REDIS_PASSWORD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'SHIM_REDIS_PW=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
run fail "REDIS_PASSWORD is only 1 characters" "REDIS_PASSWORD=a" REDIS_PASSWORD=a SHIM_REDIS_PW=a
run pass "REDIS_PASSWORD set, 32 characters" "exactly 32 characters" 'REDIS_PASSWORD=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' 'SHIM_REDIS_PW=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

echo "check 4/7: other secrets spliced into URLs and command lines"
run fail "DB_PASS has a character outside" "'@' in DB_PASS" 'DB_PASS=pass@word123'
run fail "DB_PASS has a character outside" "'/' in DB_PASS" 'DB_PASS=pass/word123'
run fail "DB_PASS is only 15 characters" "15 characters is one short" 'DB_PASS=aaaaaaaaaaaaaaa'
run fail "DB_PASS is only 1 characters" "DB_PASS=b" DB_PASS=b
run pass "DB_PASS set, 16 characters" "exactly 16 characters" 'DB_PASS=aaaaaaaaaaaaaaaa'
run fail "PG_EXPORTER_PASSWORD has a character outside" "':' in PG_EXPORTER_PASSWORD" 'PG_EXPORTER_PASSWORD=dddddddddddddddddddddd:ddddddddddddddddddddd'
run fail "PG_EXPORTER_PASSWORD is only" "too short" PG_EXPORTER_PASSWORD=short

echo "check 6: the default admin login — only an explicit rejection passes"
run pass "admin@opengateway.io is rejected by Kratos with the seeded password (HTTP 400)" "400 is the one passing outcome"
run fail "admin@opengateway.io still signs in with the seeded password" "200 with the token first" SHIM_LOGIN=token-first
run fail "admin@opengateway.io still signs in with the seeded password" "200 with the token NOT first (the old anchored regex missed this)" SHIM_LOGIN=token-later
check_true "a successful default login is revoked (a logout call was made)" test -s "$log/calls"
run fail "inconclusive: the default-admin login probe got neither a session nor an explicit rejection (wget exit 1: wget: server returned error: HTTP/1.1 500" "500 is inconclusive, not a pass" SHIM_LOGIN=500
run fail "inconclusive: the default-admin login probe got neither a session nor an explicit rejection (wget exit 1: wget: server returned error: HTTP/1.1 502 upstream replied 400" "a 502 whose text says 400 must not pass as a rejection" SHIM_LOGIN=502-400text
run fail "inconclusive: the default-admin login probe got neither a session nor an explicit rejection (wget exit 1: wget: download timed out" "a Kratos that accepts and never answers fails the run instead of hanging it (-T)" SHIM_LOGIN=hang
run fail "inconclusive: could not start a Kratos login flow" "a flow-init that never answers is bounded too" SHIM_FLOW=hang
run fail "inconclusive: the default-admin login probe got neither a session nor an explicit rejection (wget exit 1: wget: can't connect" "connection refused is inconclusive" SHIM_LOGIN=refused
run fail "inconclusive: the login probe reported HTTP 400 but wget exited 0" "a 400 line with exit 0 is not a rejection I can vouch for" SHIM_LOGIN=400-rc0
run fail "inconclusive: the default-admin login probe got neither a session nor an explicit rejection (wget exit 0: no output)" "empty answer is inconclusive" SHIM_LOGIN=empty
run fail "inconclusive: could not start a Kratos login flow" "flow init unreachable" SHIM_FLOW=down
run fail "inconclusive: could not start a Kratos login flow" "flow init empty" SHIM_FLOW=empty
run pass "admin@opengateway.io is rejected" "a quote and a backslash in the password are escaped, not allowed to break the JSON" 'DEFAULT_ADMIN_PASSWORD=a"b\c'
check_true "every wget call passes -T" sh -c '! grep -v -e " -T " "$1" | grep -q .' _ "$log/args"
check_true "the password's quote and backslash are JSON-escaped in the request body" grep -qF 'a\"b\\c' "$log/post.last"
run fail "inconclusive: DEFAULT_ADMIN_EMAIL or DEFAULT_ADMIN_PASSWORD holds a control character" "newline in the password" "DEFAULT_ADMIN_PASSWORD=line1
line2"

echo "check 8: KRATOS_SMTP_URI"
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "a real provider" 'KRATOS_SMTP_URI=smtps://u:p@smtp.example.test:465/'
run pass "KRATOS_SMTP_URI set (host smtp.sendgrid.net)" "username containing 'mailpit' must NOT be rejected" 'KRATOS_SMTP_URI=smtps://mailpit-svc:pw@smtp.sendgrid.net'
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "no userinfo, query string" 'KRATOS_SMTP_URI=smtp://smtp.example.test/?foo=bar'
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "percent-encoded @ in the password" 'KRATOS_SMTP_URI=smtps://user:p%40ss@smtp.example.test:465/'
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "raw @ in the password: the host is after the LAST @" 'KRATOS_SMTP_URI=smtps://u:p@ss@smtp.example.test:465/'
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "upper case scheme and host" 'KRATOS_SMTP_URI=SMTPS://U:P@SMTP.EXAMPLE.TEST:465/'
run fail "KRATOS_SMTP_URI points at the dev-only Mailpit" "the dev default" 'KRATOS_SMTP_URI=smtp://mailpit:1025/?skip_ssl_verify=true&disable_starttls=true'
run fail "KRATOS_SMTP_URI points at the dev-only Mailpit" "mixed-case Mailpit" 'KRATOS_SMTP_URI=smtp://Mailpit:1025'
run fail "KRATOS_SMTP_URI points at the dev-only Mailpit" "mailpit.<domain>" 'KRATOS_SMTP_URI=smtp://mailpit.internal:1025'
run fail "KRATOS_SMTP_URI host '::1' is empty, loopback or unspecified" "bracketed IPv6 loopback" 'KRATOS_SMTP_URI=smtp://[::1]:25'
run fail "KRATOS_SMTP_URI host 'localhost' is empty, loopback or unspecified" "upper-case LOCALHOST" 'KRATOS_SMTP_URI=smtp://LOCALHOST:25'
run fail "KRATOS_SMTP_URI host '0.0.0.0' is empty, loopback or unspecified" "0.0.0.0" 'KRATOS_SMTP_URI=smtp://0.0.0.0:25'
run fail "KRATOS_SMTP_URI host 'localhost' is empty, loopback or unspecified" "an '@' in the query must not move the host" 'KRATOS_SMTP_URI=smtp://localhost:25/?x=@example.com'
run fail "KRATOS_SMTP_URI host 'localhost.' is empty, loopback or unspecified" "localhost with a trailing dot" 'KRATOS_SMTP_URI=smtp://localhost.:25'
run fail "KRATOS_SMTP_URI host 'foo.localhost' is empty, loopback or unspecified" "*.localhost" 'KRATOS_SMTP_URI=smtp://foo.localhost:25'
run fail "KRATOS_SMTP_URI host '127.0.0.1' is empty, loopback or unspecified" "127.0.0.1" 'KRATOS_SMTP_URI=smtp://127.0.0.1:25'
run fail "KRATOS_SMTP_URI host '::ffff:127.0.0.1' is empty, loopback or unspecified" "IPv4-mapped loopback" 'KRATOS_SMTP_URI=smtp://[::ffff:127.0.0.1]:25'
run fail "KRATOS_SMTP_URI host 'ip6-localhost' is empty, loopback or unspecified" "ip6-localhost" 'KRATOS_SMTP_URI=smtp://ip6-localhost:25'
run fail "KRATOS_SMTP_URI host '' is empty, loopback or unspecified" "empty host" 'KRATOS_SMTP_URI=smtp://:25'
run fail "KRATOS_SMTP_URI host 'localhost' is empty, loopback or unspecified" "password containing @ in front of localhost" 'KRATOS_SMTP_URI=smtps://u:p@ss@localhost:25'
TLSMSG="KRATOS_SMTP_URI has skip_ssl_verify or disable_starttls set to something other than an explicit false"
run fail "$TLSMSG" "skip_ssl_verify=true on a real host" 'KRATOS_SMTP_URI=smtps://u:p@smtp.example.test:465/?skip_ssl_verify=true'
run fail "$TLSMSG" "disable_starttls=true on a real host" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?disable_starttls=true'
run fail "$TLSMSG" "upper-case key and value" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?SKIP_SSL_VERIFY=TRUE'
# Every spelling Go's strconv.ParseBool reads as true, and the ones it would refuse, must fail.
for v in t T 1 true TRUE True; do
  run fail "$TLSMSG" "skip_ssl_verify=$v is true to ParseBool" "KRATOS_SMTP_URI=smtp://smtp.example.test:587/?skip_ssl_verify=$v"
  run fail "$TLSMSG" "disable_starttls=$v is true to ParseBool" "KRATOS_SMTP_URI=smtp://smtp.example.test:587/?disable_starttls=$v"
done
run fail "$TLSMSG" "a value ParseBool refuses (fAlse) is not guessed at" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?skip_ssl_verify=fAlse'
run fail "$TLSMSG" "empty value" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?skip_ssl_verify='
run fail "$TLSMSG" "key with no value" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?disable_starttls'
run fail "$TLSMSG" "second parameter is the bad one" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?skip_ssl_verify=false&disable_starttls=true'
run fail "$TLSMSG" "semicolon separator" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?a=1;skip_ssl_verify=true'
run fail "$TLSMSG" "percent-encoded key (skip%5Fssl_verify)" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?skip%5Fssl_verify=true'
run fail "$TLSMSG" "percent-encoded value (%31 is 1)" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?skip_ssl_verify=%31'
run fail "$TLSMSG" "any % in the query is refused, even on an unrelated key" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?x=%20'
for v in 0 f F false FALSE False; do
  run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "skip_ssl_verify=$v is explicitly false" "KRATOS_SMTP_URI=smtps://u:p@smtp.example.test:465/?skip_ssl_verify=$v"
done
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "both flags explicitly false" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?skip_ssl_verify=false&disable_starttls=0'
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "an unrelated query parameter" 'KRATOS_SMTP_URI=smtp://smtp.example.test:587/?timeout=30&x=y'
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "a '#' fragment after a real host" 'KRATOS_SMTP_URI=smtp://smtp.example.test:25#frag'
run fail "KRATOS_SMTP_URI host 'localhost'" "'#' ends the authority: Go resolves host localhost, whatever follows" 'KRATOS_SMTP_URI=smtp://localhost:25#@smtp.example.test'
run fail "KRATOS_SMTP_URI host 'localhost'" "'#' with userinfo before it" 'KRATOS_SMTP_URI=smtp://u:p@localhost:25#@smtp.example.test'
SHAPEMSG="KRATOS_SMTP_URI's address is not host, host:port or [ipv6]:port"
run fail "$SHAPEMSG" "unencoded / in the password" 'KRATOS_SMTP_URI=smtps://secretuser:s3cr3t/pw@smtp.example.test:465/'
no_leak "secretuser" "username when the password holds a /"
no_leak "s3cr3t" "password when it holds a /"
run fail "$SHAPEMSG" "unencoded ? in the password" 'KRATOS_SMTP_URI=smtps://secretuser:s3cr3t?pw@smtp.example.test:465/'
no_leak "secretuser" "username when the password holds a ?"
run fail "$SHAPEMSG" "unencoded # in the password" 'KRATOS_SMTP_URI=smtps://secretuser:s3cr3t#pw@smtp.example.test:465/'
no_leak "secretuser" "username when the password holds a #"
run fail "$SHAPEMSG" "non-numeric port" 'KRATOS_SMTP_URI=smtp://smtp.example.test:abc'
run fail "$SHAPEMSG" "two colons" 'KRATOS_SMTP_URI=smtp://smtp.example.test:25:26'
run fail "$SHAPEMSG" "bracketed IPv6 with a bad port" 'KRATOS_SMTP_URI=smtp://[2001:db8::1]:abc'
run fail "$SHAPEMSG" "a host character outside the hostname set" 'KRATOS_SMTP_URI=smtp://smtp_ex!ample.test:25'
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "percent-encoded / in the password is fine" 'KRATOS_SMTP_URI=smtps://u:p%2Fss@smtp.example.test:465/'
run pass "KRATOS_SMTP_URI set (host 203.0.113.5)" "a public IPv4 address with a port" 'KRATOS_SMTP_URI=smtp://203.0.113.5:25'
run pass "KRATOS_SMTP_URI set (host 2001:db8::1)" "a bracketed public IPv6 literal with a port" 'KRATOS_SMTP_URI=smtp://[2001:db8::1]:25'
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "no port at all" 'KRATOS_SMTP_URI=smtp://smtp.example.test'
run fail "KRATOS_SMTP_URI host '2130706433' is a bare number" "decimal IPv4 (127.0.0.1)" 'KRATOS_SMTP_URI=smtp://2130706433:25'
run fail "KRATOS_SMTP_URI host '0x7f000001' is empty, loopback or unspecified" "hex IPv4 (127.0.0.1)" 'KRATOS_SMTP_URI=smtp://0x7f000001:25'
run fail "KRATOS_SMTP_URI is unset" "unset" -u:KRATOS_SMTP_URI
run fail "KRATOS_SMTP_URI is not an smtp:// or smtps:// URI" "wrong scheme" 'KRATOS_SMTP_URI=http://smtp.example.test'
run fail "KRATOS_SMTP_URI contains whitespace" "trailing space" 'KRATOS_SMTP_URI=smtps://u:p@smtp.example.test:465/ '
# Credentials must never be printed, on the failure path or the pass path.
run fail "KRATOS_SMTP_URI host 'localhost'" "credentials in a rejected URI" 'KRATOS_SMTP_URI=smtps://secretuser:s3cr3tpw@localhost:25'
no_leak "s3cr3tpw" "SMTP password, rejected URI"
no_leak "secretuser" "SMTP username, rejected URI"
run pass "KRATOS_SMTP_URI set (host smtp.example.test)" "credentials in an accepted URI" 'KRATOS_SMTP_URI=smtps://secretuser:s3cr3tpw@smtp.example.test:465/'
no_leak "s3cr3tpw" "SMTP password, accepted URI"
no_leak "secretuser" "SMTP username, accepted URI"

echo "check 9: Kratos session cookie Secure"
run pass "KRATOS_COOKIE_SECURE=true" "true"
run fail "KRATOS_COOKIE_SECURE is 'false'" "false" KRATOS_COOKIE_SECURE=false
run fail "KRATOS_COOKIE_SECURE is 'unset'" "unset" -u:KRATOS_COOKIE_SECURE
run fail "KRATOS_COOKIE_SECURE is 'True'" "only the exact string true counts" KRATOS_COOKIE_SECURE=True

echo "check 10: dashboard / API session cookies Secure"
run pass "COOKIE_SECURE=true" "true"
run fail "COOKIE_SECURE is 'false'" "false overrides NODE_ENV=production" COOKIE_SECURE=false
run fail "COOKIE_SECURE is 'unset'" "unset" -u:COOKIE_SECURE
run fail "COOKIE_SECURE is 'TRUE'" "only the exact string true counts" COOKIE_SECURE=TRUE

echo
if [ "$failed" -eq 0 ]; then
  echo "prod-preflight.check: all $total assertions passed"
  exit 0
fi
echo "prod-preflight.check: $failed of $total assertions FAILED" >&2
exit 1
