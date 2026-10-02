#!/usr/bin/env bash
# ============================================================================
# MIRQAB — Full Stack Installer (v2.0)
# ============================================================================
# One-command setup for the entire MIRQAB stack.
#
# Usage:
#   bash install.sh                    # Interactive mode
#   bash install.sh --non-interactive  # Automated mode (uses defaults)
#   bash install.sh --debug            # Enable debug mode (set -x)
#   bash install.sh --verbose          # Show full command output (no tail)
#
# What it does:
#   1. Checks prerequisites (Node.js, pnpm, Docker)
#   2. Validates environment and configuration
#   3. Generates secure environment files
#   4. Installs dependencies
#   5. Builds the entire stack
#   6. Generates Prisma client
#   7. Starts services via Docker Compose
#   8. Runs health checks with proper error handling
#   9. Runs database migrations and seeding
#  10. Prints access URLs
# ============================================================================

set -euo pipefail

# ─── Script Metadata ──────────────────────────────────────────────────────
SCRIPT_NAME="install.sh"
SCRIPT_VERSION="2.0.0"
SCRIPT_START_TIME=${SECONDS:-0}

# ─── Mode Flags ────────────────────────────────────────────────────────────
DEBUG=${DEBUG:-0}
VERBOSE=${VERBOSE:-0}

# ─── Colors ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ─── Configuration ──────────────────────────────────────────────────────────
HOST_WEB=33000
HOST_API=33001
HOST_DB=33002
HOST_REDIS=33003
HOST_TYK_GW=33005
HOST_HYDRA_PUBLIC=33010
HOST_HYDRA_ADMIN=33011
HOST_KRATOS_PUBLIC=33012
HOST_KRATOS_ADMIN=33013
HOST_KETO_READ=33014
HOST_KETO_WRITE=33015

# Generate secure credentials
generate_secret() {
  if command -v openssl &> /dev/null; then
    openssl rand -base64 32
  elif command -v node &> /dev/null; then
    node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
else
  echo "ERROR: No secure random number generator available (openssl or node required)" >&2
  exit 1
fi
}

# Hex secret of $1 bytes (so 2*$1 characters). Kratos' cipher secret must be exactly 32 chars.
rand_hex() {
  openssl rand -hex "$1" 2>/dev/null \
    || node -e "console.log(require('crypto').randomBytes($1).toString('hex'))" 2>/dev/null
}

DB_USER="opengateway"
DB_PASS=""
DB_NAME="opengateway"

JWT_SECRET=""
TYK_GW_SECRET=""

# Ory stack (Hydra/Kratos/Keto). Keto has no secrets of its own.
HYDRA_SECRETS_SYSTEM=""
HYDRA_SECRETS_COOKIE=""
KRATOS_SECRETS_DEFAULT=""
KRATOS_SECRETS_COOKIE=""
KRATOS_SECRETS_CIPHER=""

# WP29a: only infra/docker-compose.prod.yml reads this.
REDIS_PASSWORD=""

# WP27: the shared secret Tyk's event handler presents to the api's own relay endpoint.
TYK_WEBHOOK_RELAY_SECRET=""

# OG-OBS-02: the og_monitor role postgres-exporter logs in as.
PG_EXPORTER_PASSWORD=""

# Written into infra/.env so a bare `docker compose -f infra/docker-compose.yml up -d` (which is all
# `pnpm infra:up` runs) starts the dev-only Mailpit too; without it Kratos mails a host that does not
# exist and recovery codes vanish. Set unconditionally, not inherited from the caller's shell: this
# file is the development flow. NEVER put it in a server's infra/.env (infra/.env.production.example
# does not, and infra/scripts/check-prod-ports.sh fails on it). Note an explicit `--profile` on the
# command line REPLACES this variable rather than adding to it, so `--profile multinode` needs
# `--profile dev` beside it to keep Mailpit.
COMPOSE_PROFILES="dev"

NON_INTERACTIVE=false
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/infra/docker-compose.yml"

# ─── Logging Setup ──────────────────────────────────────────────────────────
LOG_DIR="${SCRIPT_DIR}/.install-logs"
LOG_FILE="${LOG_DIR}/install-$(date +%Y%m%d-%H%M%S).log"
INSTALL_ID=$(uuidgen 2>/dev/null || openssl rand -hex 16 2>/dev/null || date +%s)

# Create log directory
mkdir -p "$LOG_DIR"

# Redirect output to both log file and stdout
exec 3>&1
exec 4>&2
exec 1> >(tee -a "$LOG_FILE") 2>&1

# ─── Helper Functions ───────────────────────────────────────────────────────
log() { echo -e "${GREEN}[$(date +'%Y-%m-%d %H:%M:%S')] [OPEN-GATEWAY]${NC} $1" >&3; }
warn() { echo -e "${YELLOW}[$(date +'%Y-%m-%d %H:%M:%S')] [WARN]${NC} $1" >&3; }
error() { echo -e "${RED}[$(date +'%Y-%m-%d %H:%M:%S')] [ERROR]${NC} $1" >&3; }
debug() { [ $DEBUG -eq 1 ] && echo -e "${BLUE}[$(date +'%Y-%m-%d %H:%M:%S')] [DEBUG]${NC} $1" >&3 || true; }
step() { echo -e "\n${BOLD}${CYAN}━━━ $1 ━━━${NC}" >&3; }
success() { echo -e "${GREEN}✅ $1${NC}" >&3; }
fail() { error "$1"; cleanup; exit 1; }

cleanup() {
  local exit_code=$?
  if [ $exit_code -ne 0 ]; then
    echo "" >&3
    error "Installation failed with exit code $exit_code"
    error "Install ID: $INSTALL_ID (use for troubleshooting)"
    error "Log file: $LOG_FILE"
    error "Partial .env files may exist at:"
    error "  - ${SCRIPT_DIR}/apps/api/.env.local"
    error "  - ${SCRIPT_DIR}/apps/web/.env.local"
    error "To retry: bash install.sh"
  fi
}

trap cleanup EXIT

# Every credential this script owns. `infra/.env` is the single source of truth for all of them:
# apps/api/.env.local and apps/web/.env.local are DERIVED from these same variables, so reusing the
# values here rebuilds those two files identically and they never need parsing of their own.
MANAGED_SECRETS=(
  TYK_GW_SECRET JWT_SECRET DB_PASS
  HYDRA_SECRETS_SYSTEM HYDRA_SECRETS_COOKIE
  KRATOS_SECRETS_DEFAULT KRATOS_SECRETS_COOKIE KRATOS_SECRETS_CIPHER
  REDIS_PASSWORD TYK_WEBHOOK_RELAY_SECRET PG_EXPORTER_PASSWORD
)

# Every key this script WRITES into infra/.env. The secrets plus EDGE_LAN_IP and COMPOSE_PROFILES, which
# are not credentials but are still ours to emit — and, like the secrets, are kept if the file already has them,
# because auto-detection picks one interface and a multi-homed host may need a different one.
# Each name here is also the shell variable holding its value, which is what lets the writer below
# use `${!key}` instead of a case statement that would drift from this list.
MANAGED_ENV_KEYS=( "${MANAGED_SECRETS[@]}" EDGE_LAN_IP COMPOSE_PROFILES )

# A managed key written in a shape the strict parser cannot read is an ERROR, never an absence.
#
# This is the dangerous case, not a cosmetic one: `export DB_PASS=x` or an indented key is honoured
# by docker compose but missed by `load_existing_secrets`, which would then treat the secret as
# absent, mint a new one, and — because the writer rewrites the file — drop the original line. The
# result is a silently rotated live credential, which is the whole failure this reuse logic exists
# to prevent. Quoted and trailing-whitespace values are rejected for a related reason: compose
# strips both, this script does not, so the value would round-trip through infra/.env intact while
# being interpolated RAW into apps/api/.env.local (`DATABASE_URL=...:"quoted"@...`).
#
# Rejecting rather than normalising is deliberate. Matching compose's full quoting, export and
# whitespace semantics means a second dotenv parser written in Bash, which will drift from the real
# one exactly as the comment in load_existing_secrets once did.
#
# `KEY=` with an empty value is ACCEPTED and treated as absent: compose rejects an empty `${VAR:?}`
# anyway, so regenerating is both safe and what the operator meant.
#
# The message names the key and the line, NEVER the value — installer output gets pasted into bug
# reports.
assert_strict_env_lines() {
  local env_file="${SCRIPT_DIR}/infra/.env" key loose offender line_no
  [ -f "$env_file" ] || return 0
  for key in "${MANAGED_ENV_KEYS[@]}"; do
    # Lines that look like this key, minus the ones in the exact form we can read. No `head` in
    # this pipeline: it exits early, and the resulting SIGPIPE trips `set -o pipefail`.
    loose=$(grep -nE "^[[:space:]]*(export[[:space:]]+)?${key}[[:space:]]*=" "$env_file" || true)
    [ -n "$loose" ] || continue
    offender=$(printf '%s\n' "$loose" | grep -vE "^[0-9]+:${key}=([^[:space:]'\"][^[:space:]]*)?$" || true)
    if [ -n "$offender" ]; then
      line_no=${offender%%$'\n'*}
      line_no=${line_no%%:*}
      fail "infra/.env line ${line_no}: ${key} is set in a form install.sh cannot read (an \`export\` prefix, leading whitespace, spaces around \`=\`, quotes, or a trailing space or CR). Normalise it to ${key}=value — left as is, the secret would be treated as missing and regenerated, silently replacing the one your stack is already using."
    fi

    # Present but EMPTY. The reader skips it as absent and mints a value, which reaches the derived
    # apps/*/.env.local files — but the writer below leaves the empty line alone, because the key
    # does exist. The two files would then disagree: compose rejects the empty `${VAR:?}` loudly, so
    # nothing is silent, but the error points at the wrong thing.
    #
    # Judged on the LAST occurrence, the same rule the reader and compose both use, so an empty line
    # followed by a real one is fine rather than a false alarm.
    last=$(printf '%s\n' "$loose" | tail -n 1)
    if [ -z "${last#*"${key}="}" ]; then
      line_no=${last%%:*}
      fail "infra/.env line ${line_no}: ${key} is empty. Delete the line to have install.sh regenerate it, or set a value."
    fi
  done
  return 0
}

# Load what an existing infra/.env already holds, so a re-run keeps it.
#
# PARSED, never sourced. A .env is data; `source` would execute whatever is in it, and a file this
# script wrote with mode 600 is still not a reason to run it. The value is taken verbatim after the
# first `=` so it survives byte for byte — no requoting, no trimming, no expansion.
#
# Why this exists: README promised the script was "safe to re-run" while generate_all_secrets minted
# fresh values unconditionally and the write block truncated the file. A re-run therefore rotated
# every credential against state that still held the old one — most sharply DB_PASS, because
# POSTGRES_PASSWORD only applies when the volume is first initialised, so Postgres kept demanding
# the previous password while the app had been handed a new one. See README's rotation table.
load_existing_secrets() {
  local env_file="${SCRIPT_DIR}/infra/.env" key value
  [ -f "$env_file" ] || return 0
  # Stop on an unreadable-but-present key before deciding anything is missing.
  assert_strict_env_lines
  for key in "${MANAGED_SECRETS[@]}"; do
    # LAST occurrence wins, because that is what docker compose resolves for a duplicated key —
    # measured, not assumed: a file holding `FOO=first` then `FOO=second` makes `compose config`
    # report `second`. Taking the first would have this script reuse a value compose never used and
    # then rewrite the file with it, silently rotating the live credential — the exact failure this
    # function exists to prevent, hiding in a hand-edited .env.
    #
    # `tail -n 1`, never `head -n 1`: head exits as soon as it has its line, and once the file is
    # long enough for sed to still be writing, the resulting SIGPIPE makes the pipeline exit 141
    # under this script's `set -o pipefail` and aborts the install. tail drains the pipe instead.
    value=$(sed -n "s/^${key}=\(.*\)$/\1/p" "$env_file" | tail -n 1)
    [ -n "$value" ] || continue
    printf -v "$key" '%s' "$value"
    debug "$key reused from existing infra/.env"
  done
  return 0
}

# Generate $1 as $2 random bytes ONLY if it is still empty, so a value loaded above survives.
#
# `${!name:-}`, not `${!name}`: this script runs under `set -u` (line 26), so an indirect expansion
# of a name that was never declared aborts the install with a bare "unbound variable". Every name in
# MANAGED_SECRETS is declared empty above today, which is exactly what would make that failure a
# surprise later — adding a secret to the list and forgetting the declaration would break the
# installer rather than generate the secret.
ensure_hex_secret() {
  local name="$1" bytes="$2" value
  if [ -n "${!name:-}" ]; then
    return 0
  fi
  value=$(rand_hex "$bytes")
  [ -n "$value" ] || fail "Cannot generate $name: openssl and node both unavailable"
  printf -v "$name" '%s' "$value"
  return 0
}

generate_all_secrets() {
  load_existing_secrets

  ensure_hex_secret DB_PASS 16
  # Same `:-` reasoning as ensure_hex_secret: declared above today, but `set -u` turns a future
  # missing declaration into an aborted install rather than a generated secret.
  if [ -z "${JWT_SECRET:-}" ]; then
    JWT_SECRET=$(generate_secret)
  fi
  ensure_hex_secret TYK_GW_SECRET 32
  if [ -z "$TYK_GW_SECRET" ]; then
    fail "Cannot generate Tyk gateway secret: openssl and node both unavailable"
  fi

  # Ory stack. Every one of these is required by infra/docker-compose.yml (`${VAR:?...}`), so the
  # Ory containers refuse to start rather than fall back to a committed key.
  ensure_hex_secret HYDRA_SECRETS_SYSTEM 32
  ensure_hex_secret HYDRA_SECRETS_COOKIE 32
  ensure_hex_secret KRATOS_SECRETS_DEFAULT 32
  ensure_hex_secret KRATOS_SECRETS_COOKIE 32
  # Exactly 32 characters: Kratos validates the cipher secret's length and exits if it differs.
  ensure_hex_secret KRATOS_SECRETS_CIPHER 16

  # WP29a: required only by infra/docker-compose.prod.yml, which makes Redis demand a password.
  # Generated here anyway so the prod overlay is one flag away rather than one more secret to think
  # of; the default (dev) profile leaves Redis unauthenticated behind its loopback-only port and
  # ignores this value entirely.
  ensure_hex_secret REDIS_PASSWORD 32

  # WP27: required by the DEFAULT infra/docker-compose.yml (`${...:?}`), unlike REDIS_PASSWORD
  # above — without it the api container refuses to start, so a fresh install never came up at all.
  # The relay endpoint is `@Public()` and reachable through the edge like any other route, so this
  # header secret is the only thing separating a real Tyk event from a forged one. An empty value
  # makes the controller reject every call (fail closed), which is safe but silently dead.
  ensure_hex_secret TYK_WEBHOOK_RELAY_SECRET 32

  # OG-OBS-02: pg-monitoring-init sets it as the og_monitor role's password on every `up`, and
  # postgres-exporter logs in with it. Soft in the default compose file — missing, only Postgres
  # monitoring fails (closed) — and required by the prod overlay. Kept on re-run like every other
  # secret here, so an existing install only ever gains it, never rotates it.
  ensure_hex_secret PG_EXPORTER_PASSWORD 32

  # Not a credential: the host's primary LAN address, so the WP26b edge's internal CA issues for
  # https://<lan-ip>:<port> as well as localhost. Empty is fine — the listeners still answer on
  # loopback, and the Caddyfile falls back to 127.0.0.1.
  EDGE_LAN_IP=$(ip -4 -o route get 1.1.1.1 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p')

  debug "Secure credentials generated"
  return 0
}

generate_all_secrets

# ─── Parse Arguments ───────────────────────────────────────────────────────
for arg in "$@"; do
  case "$arg" in
    --non-interactive) NON_INTERACTIVE=true ;;
    --debug) DEBUG=1; set -x ;;
    --verbose) VERBOSE=1 ;;
    --help|-h)
      echo "Usage: bash install.sh [OPTIONS]" >&3
      echo "" >&3
      echo "Options:" >&3
      echo "  --non-interactive  Skip all prompts, use defaults" >&3
      echo "  --debug            Enable debug mode (set -x)" >&3
      echo "  --verbose          Show full command output (no tail)" >&3
      echo "  --help, -h         Show this help" >&3
      exit 0
      ;;
  esac
done

# ─── Debug Info ─────────────────────────────────────────────────────────────
debug "Script environment:"
debug "  SCRIPT_DIR=$SCRIPT_DIR"
debug "  COMPOSE_FILE=$COMPOSE_FILE"
debug "  NON_INTERACTIVE=$NON_INTERACTIVE"
debug "  DEBUG=$DEBUG"
debug "  VERBOSE=$VERBOSE"
debug "  INSTALL_ID=$INSTALL_ID"
debug "  LOG_FILE=$LOG_FILE"

log "Install ID: $INSTALL_ID"

# ─── 1. Prerequisites ───────────────────────────────────────────────────────
step "Checking Prerequisites"

check_cmd() {
  local cmd="$1"
  local name="$2"
  local min_version="${3:-}"
  
  if ! command -v "$cmd" &> /dev/null; then
    error "$name is not installed."
    case "$name" in
      "Node.js") echo "  Install: https://nodejs.org/" >&3;;
      "pnpm") echo "  Install: corepack enable && corepack prepare pnpm@10.4.1 --activate" >&3;;
      "Docker") echo "  Install: https://docs.docker.com/get-docker/" >&3;;
    esac
    exit 1
  fi
  
  # Version check if specified
  if [ -n "$min_version" ]; then
    local current_version
    case "$cmd" in
      "node") current_version=$(node -v | sed 's/v//') ;;
      "pnpm") current_version=$(pnpm -v) ;;
      *) current_version=$($cmd --version 2>/dev/null | head -1) ;;
    esac
    
    debug "  $name version: $current_version (required: $min_version+)"
  fi
  
  log "$name: $(command -v "$cmd")"
}

# Check corepack is available
if ! command -v corepack &> /dev/null; then
  fail "Corepack not available. Update Node.js to 16.13+ or install corepack manually"
fi

check_cmd "node" "Node.js" "20.0.0"
check_cmd "pnpm" "pnpm" "9.0.0"
check_cmd "docker" "Docker"

# Validate Node.js version
NODE_MAJOR=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_MAJOR" -lt 20 ]; then
  fail "Node.js 20+ required. Found: $(node -v)"
fi

# Validate pnpm version
PNPM_VERSION=$(pnpm -v | cut -d'.' -f1)
if [ "$PNPM_VERSION" -lt 9 ]; then
  fail "pnpm 9.0.0+ required. Found: $(pnpm -v)"
fi

# Verify Docker is running
if ! docker info &> /dev/null; then
  fail "Docker is not running."
fi

# Verify Docker Compose v2
if ! docker compose version &> /dev/null; then
  fail "Docker Compose v2 is required."
fi

success "All prerequisites met (Node.js $(node -v), pnpm $(pnpm -v))"

# ─── 2. Pre-flight Checks ─────────────────────────────────────────────────
step "Pre-flight Checks"

# Check port availability
log "Checking port availability..."
# $HOST_TYK_GW is published too (the gateway data plane), so a conflict there breaks routing.
# The Ory ports are published as well (see infra/docker-compose.yml) so they're checked too.
for port in $HOST_WEB $HOST_API $HOST_DB $HOST_REDIS $HOST_TYK_GW \
            $HOST_HYDRA_PUBLIC $HOST_HYDRA_ADMIN $HOST_KRATOS_PUBLIC $HOST_KRATOS_ADMIN \
            $HOST_KETO_READ $HOST_KETO_WRITE; do
  if netstat -tulpn 2>/dev/null | grep -q ":$port "; then
    warn "Port $port already in use (may cause conflicts)"
  fi
done

# Check disk space
AVAILABLE_GB=$(df "$SCRIPT_DIR" | awk 'NR==2 {print int($4/1024/1024)}')
if [ "$AVAILABLE_GB" -lt 5 ]; then
  fail "Less than 5GB free disk space available (found ${AVAILABLE_GB}GB). Docker images require ~8GB."
fi
log "Disk space available: ${AVAILABLE_GB}GB"

# Verify .gitignore blocks .env files
if [ -f "${SCRIPT_DIR}/.gitignore" ]; then
  if ! grep -q "^\.env\.local$" "${SCRIPT_DIR}/.gitignore"; then
    warn ".env.local not in .gitignore — consider adding it"
  fi
fi

success "Pre-flight checks passed"

# ─── 4. Install Dependencies ───────────────────────────────────────────────
step "Installing Dependencies"

log "Running pnpm install..."

# Function to run commands with proper logging
run_cmd() {
  local cmd="$1"
  local description="$2"
  local log_file="$3"
  
  if [ $VERBOSE -eq 1 ]; then
    eval "$cmd" 2>&1 | tee "$log_file"
    return ${PIPESTATUS[0]}
  else
    eval "$cmd" > "$log_file" 2>&1
    local exit_code=$?
    if [ $exit_code -ne 0 ]; then
      error "$description failed"
      error "Last 50 lines of output:"
      tail -50 "$log_file" | sed 's/^/  /' >&3
      return $exit_code
    fi
    tail -3 "$log_file" >&3
    return 0
  fi
}

INSTALL_LOG="${LOG_DIR}/pnpm-install-$(date +%s).log"
if ! run_cmd "pnpm install --frozen-lockfile" "Dependency installation" "$INSTALL_LOG"; then
  fail "Failed to install dependencies. See log: $INSTALL_LOG"
fi

success "Dependencies installed"

# Verify workspace integrity
log "Verifying workspace package links..."
if ! pnpm ls @open-gateway/ui @open-gateway/types @open-gateway/database &>/dev/null; then
  fail "Workspace package links are broken. Run: pnpm clean && pnpm install"
fi

# ─── 5. Generate Environment Files ────────────────────────────────────────
step "Configuring Environment"

# Create API .env.local
log "Generating API environment configuration..."
cat > "${SCRIPT_DIR}/apps/api/.env.local" <<EOF
# ─── Server ──────────────────────────────────────────────
# Development server configuration
PORT=4000
NODE_ENV=development

# ─── Database ────────────────────────────────────────────
# PostgreSQL connection string (auto-generated secure credentials)
# IMPORTANT: These credentials are unique per installation
# Host-side (pnpm dev), not the compose network — localhost + the published port, matching
# apps/api/.env.example. The api container itself gets its own DATABASE_URL directly from
# infra/docker-compose.yml (compose-network hostname), unaffected by this file (see .dockerignore).
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${HOST_DB}/${DB_NAME}?schema=public"

# ─── Redis ───────────────────────────────────────────────
# Redis cache/session store
REDIS_URL="redis://localhost:${HOST_REDIS}"

# ─── JWT / Auth ─────────────────────────────────────────
# JWT secret (auto-generated, 256-bit)
# IMPORTANT: Keep this secret! Do not commit to version control
JWT_SECRET="${JWT_SECRET}"
JWT_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d

# ─── Ory (Hydra / Kratos / Keto) ────────────────────────
# Access tokens are issued by Hydra and verified against its JWKS. ISSUER is the browser-facing
# \`iss\` claim Hydra stamps (urls.self.issuer in infra/ory/hydra/hydra.yml) — NOT the host the JWKS
# is fetched from. Host-side (pnpm dev) ports, matching apps/api/.env.example.
# The five application ports are HTTPS since WP26b — the Caddy edge is the only publisher and it
# terminates TLS with its own internal CA. For a host-side \`pnpm dev\` process to talk to them,
# export the CA root and point Node at it (see infra/edge/README.md):
#   docker compose -f infra/docker-compose.yml cp edge:/data/caddy/pki/authorities/local/root.crt infra/edge/root.crt
#   export NODE_EXTRA_CA_CERTS=\$PWD/infra/edge/root.crt
# The admin ports (Hydra 33011, Kratos 33013, Keto 33014/33015) are loopback-only and unrouted, so
# they stay plain HTTP.
ORY_HYDRA_PUBLIC_URL=https://localhost:${HOST_HYDRA_PUBLIC}
ORY_HYDRA_ADMIN_URL=http://localhost:${HOST_HYDRA_ADMIN}
ORY_HYDRA_ISSUER=https://localhost:${HOST_HYDRA_PUBLIC}/
ORY_KRATOS_PUBLIC_URL=https://localhost:${HOST_KRATOS_PUBLIC}
ORY_KRATOS_ADMIN_URL=http://localhost:${HOST_KRATOS_ADMIN}
# Keto answers tenant membership: read = check, write = relation tuples.
ORY_KETO_READ_URL=http://localhost:${HOST_KETO_READ}
ORY_KETO_WRITE_URL=http://localhost:${HOST_KETO_WRITE}

# ─── CORS ───────────────────────────────────────────────
# Allowed origins for CORS (localhost only in development)
CORS_ORIGINS=https://localhost:${HOST_WEB}

# ─── Tyk Integration ────────────────────────────────────
# Tyk OSS Gateway REST API (<gateway>/tyk); secret = TYK_GW_SECRET (see infra/.env).
# The control API runs on port 8081 (TYK_GW_CONTROLAPIPORT) and is NOT published to the host;
# port 33005 is the data plane only. /hello is served by the control API port as well.
TYK_ADMIN_URL=http://tyk-gateway:8081/tyk
TYK_ADMIN_SECRET=${TYK_GW_SECRET}
TYK_GATEWAY_URL=http://tyk-gateway:8081
TYK_ORG_ID=org123

# Extra upstream hosts an API may never proxy to (comma separated), on top of the built-in
# denylist (loopback, link-local / cloud metadata, the platform's own service names).
PROXY_DENY_HOSTS=

# ─── Analytics pipeline ──────────────────────────────────
# Tyk Pump liveness probe for GET /api/analytics/health. Inside compose the pump answers on
# tyk-pump:8083; its port is not published, so an API running on the host instead of in compose
# needs its own published pump port or analytics will report "pump not running".
PUMP_HEALTH_URL=http://tyk-pump:8083/health

# Daily retention trim of the pump-owned tables
ANALYTICS_RETENTION_DAYS=30
ANALYTICS_AGGREGATE_RETENTION_DAYS=365

# ─── Logging ─────────────────────────────────────────────
# Log level: debug, info, warn, error
LOG_LEVEL=debug

# ─── OpenTelemetry ───────────────────────────────────────
# Distributed tracing configuration
OTEL_SERVICE_NAME=open-gateway-api
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318
EOF

# docker compose reads infra/.env: the gateway secret is shared between tyk-gateway and the API
# container, and JWT_SECRET is required by the compose file — without it the api service refuses to
# start rather than fall back to a committed key.
log "Generating compose environment (infra/.env)..."
if [ -f "${SCRIPT_DIR}/infra/.env" ]; then
  # An existing file is EDITED, never rewritten: every line survives byte for byte and only keys it
  # is missing get appended.
  #
  # Rewriting it truncated everything this script does not itself emit, and that is not a
  # hypothetical loss — the compose file tells operators to set `TYK_ADMIN_URLS` here for the
  # multinode profile and `KRATOS_SMTP_URI` for real mail, and the prod overlay reads `EDGE_IMAGE` /
  # `API_IMAGE` / `WEB_IMAGE` from here too. Measured before this change: all of those, plus a
  # hand-corrected EDGE_LAN_IP, were silently gone after one re-run, which left README's "safe to
  # re-run" false for everything except the secrets.
  #
  # `${!key}` works because every name in MANAGED_ENV_KEYS is also the variable holding its value.
  _env_added=0
  for _env_key in "${MANAGED_ENV_KEYS[@]}"; do
    grep -qE "^${_env_key}=" "${SCRIPT_DIR}/infra/.env" && continue
    if [ "$_env_added" -eq 0 ]; then
      printf '\n# Added by install.sh on %s — keys this file did not have.\n' "$(date +%F)" \
        >> "${SCRIPT_DIR}/infra/.env"
      _env_added=1
    fi
    printf '%s=%s\n' "$_env_key" "${!_env_key:-}" >> "${SCRIPT_DIR}/infra/.env"
    debug "$_env_key appended to existing infra/.env"
  done
  chmod 600 "${SCRIPT_DIR}/infra/.env"
else
umask 077
{
  printf 'TYK_GW_SECRET=%s\n' "$TYK_GW_SECRET"
  printf 'JWT_SECRET=%s\n' "$JWT_SECRET"
  printf 'DB_PASS=%s\n' "$DB_PASS"
  # Ory stack (Hydra/Kratos/Keto). Keto needs no secret of its own.
  printf 'HYDRA_SECRETS_SYSTEM=%s\n' "$HYDRA_SECRETS_SYSTEM"
  printf 'HYDRA_SECRETS_COOKIE=%s\n' "$HYDRA_SECRETS_COOKIE"
  printf 'KRATOS_SECRETS_DEFAULT=%s\n' "$KRATOS_SECRETS_DEFAULT"
  printf 'KRATOS_SECRETS_COOKIE=%s\n' "$KRATOS_SECRETS_COOKIE"
  printf 'KRATOS_SECRETS_CIPHER=%s\n' "$KRATOS_SECRETS_CIPHER"
  # WP29a: read only by infra/docker-compose.prod.yml (Redis `--requirepass`, and the matching
  # password on the API, the gateway nodes and the pump). Unused by the default dev profile.
  printf 'REDIS_PASSWORD=%s\n' "$REDIS_PASSWORD"
  # WP27: Tyk's own event handler sends this back to the api's @Public() relay endpoint, which is
  # what tells a real Tyk event from a forged one. Required by the default compose file.
  printf 'TYK_WEBHOOK_RELAY_SECRET=%s\n' "$TYK_WEBHOOK_RELAY_SECRET"
  # OG-OBS-02: the og_monitor role postgres-exporter logs in as. Without it Postgres monitoring stays off.
  printf 'PG_EXPORTER_PASSWORD=%s\n' "$PG_EXPORTER_PASSWORD"
  # WP26b edge: the host's LAN address, so `tls internal` also issues a certificate for
  # https://<lan-ip>:<port>. Not a secret; empty falls back to loopback-only listeners.
  printf 'EDGE_LAN_IP=%s\n' "$EDGE_LAN_IP"
  # Development only: starts the Mailpit mail sink on a bare `docker compose up`. See the declaration.
  printf 'COMPOSE_PROFILES=%s\n' "$COMPOSE_PROFILES"
} > "${SCRIPT_DIR}/infra/.env"
umask 022
chmod 600 "${SCRIPT_DIR}/infra/.env"
fi

# Create Web .env.local
log "Generating Web environment configuration..."
cat > "${SCRIPT_DIR}/apps/web/.env.local" <<EOF
# ─── Web Frontend Configuration ───────────────────────────
# NEXT_PUBLIC_* variables are exposed to the browser
# Only include public URLs and non-sensitive configuration

# Base URL for the Next.js application. https since WP26b: the Caddy edge is the only publisher of
# these five ports and it terminates TLS (infra/edge/README.md — install its CA root first).
NEXT_PUBLIC_APP_URL=https://localhost:${HOST_WEB}

# Backend API endpoint (must be reachable from browser)
NEXT_PUBLIC_API_URL=https://localhost:${HOST_API}/api

# ─── Ory (browser-facing — must be reachable from the browser, never the in-network hydra:/kratos: names) ───
NEXT_PUBLIC_KRATOS_URL=https://localhost:${HOST_KRATOS_PUBLIC}
NEXT_PUBLIC_HYDRA_URL=https://localhost:${HOST_HYDRA_PUBLIC}

# ─── Ory (server-to-server — this process's own outbound calls; unreachable in Docker, where the
# web container instead defaults to the in-network hydra:/kratos: names baked into the code) ───
# Hydra admin is loopback-only and not routed through the edge, so it stays plain HTTP.
HYDRA_PUBLIC_URL=https://localhost:${HOST_HYDRA_PUBLIC}
HYDRA_ADMIN_URL=http://127.0.0.1:${HOST_HYDRA_ADMIN}
KRATOS_INTERNAL_URL=https://localhost:${HOST_KRATOS_PUBLIC}

# ─── Database ────────────────────────────────────────────
# /oauth2/login provisions the local User row for a Kratos identity directly via Prisma —
# without this, login 500s on "Environment variable not found: DATABASE_URL".
DATABASE_URL="postgresql://${DB_USER}:${DB_PASS}@localhost:${HOST_DB}/${DB_NAME}?schema=public"
EOF

# Set restrictive permissions on .env files
chmod 600 "${SCRIPT_DIR}/apps/api/.env.local"
chmod 600 "${SCRIPT_DIR}/apps/web/.env.local"

success "Environment files generated with secure credentials"

# ─── 6. Build Packages ──────────────────────────────────────────────────────
step "Building Packages"

log "Building API..."
API_BUILD_LOG="${LOG_DIR}/api-build-$(date +%s).log"
if ! run_cmd "pnpm --filter @open-gateway/api build" "API build" "$API_BUILD_LOG"; then
  fail "API build failed. See log: $API_BUILD_LOG"
fi

log "Building Web..."
WEB_BUILD_LOG="${LOG_DIR}/web-build-$(date +%s).log"
if ! run_cmd "pnpm --filter @open-gateway/web build" "Web build" "$WEB_BUILD_LOG"; then
  warn "Web build completed with warnings. See log: $WEB_BUILD_LOG"
else
  # Check build sizes
  WEB_SIZE=$(du -sm apps/web/.next 2>/dev/null | awk '{print $1}')
  if [ -n "$WEB_SIZE" ]; then
    log "Web build size: ${WEB_SIZE}MB"
    if [ "$WEB_SIZE" -gt 500 ]; then
      warn "Web build exceeds 500MB. Consider optimization."
    fi
  fi
fi

success "Build complete"

# ─── 7. Generate Prisma Client ───────────────────────────────────────────────
step "Generating Prisma Client"

PRISMA_LOG="${LOG_DIR}/prisma-generate-$(date +%s).log"
if ! run_cmd "pnpm db:generate" "Prisma client generation" "$PRISMA_LOG"; then
  fail "Failed to generate Prisma client. See log: $PRISMA_LOG"
fi

success "Prisma client generated"

# ─── 8. Start Full Stack ────────────────────────────────────────────────────
step "Starting Full Stack via Docker Compose"

# Build compose arguments array. `--profile dev` starts the dev-only Mailpit that Kratos mails to by
# default; production (docs/go-live.md) never passes it and sets KRATOS_SMTP_URI instead.
COMPOSE_ARGS_ARRAY=("-f" "$COMPOSE_FILE" "--profile" "dev")

log "Building and starting all services..."
DOCKER_LOG="${LOG_DIR}/docker-compose-$(date +%s).log"
if ! run_cmd "docker compose ${COMPOSE_ARGS_ARRAY[*]} up -d --build" "Docker Compose startup" "$DOCKER_LOG"; then
  error "Docker Compose failed to start services"
  error "Common causes:"
  error "  1. Docker daemon not running: docker ps"
  error "  2. Port conflicts: lsof -i :${HOST_WEB}, :${HOST_API}, etc."
  error "  3. Insufficient disk space: df -h"
  error "  4. Invalid compose file: cat $COMPOSE_FILE"
  error "Full log: $DOCKER_LOG"
  exit 1
fi

success "Services started"

# ─── 9. Health Checks ───────────────────────────────────────────────────────
step "Waiting for Services to be Healthy"

wait_healthy() {
  local service="$1"
  local max_wait="$2"
  local start_time
  start_time=$(date +%s)
  local elapsed=0
  
  log "Waiting for $service to be healthy (max ${max_wait}s)..."
  while [ $elapsed -lt $max_wait ]; do
    # Match only "(healthy)" — plain "healthy" also matches the substring inside "(unhealthy)".
    if docker compose "${COMPOSE_ARGS_ARRAY[@]}" ps "$service" 2>/dev/null | grep -qE '\(healthy\)'; then
      local duration
      duration=$(($(date +%s) - start_time))
      success "$service is healthy (took ${duration}s)"
      return 0
    fi
    printf "." >&3
    if [ $((elapsed % 30)) -eq 0 ] && [ $elapsed -gt 0 ]; then
      echo " [${elapsed}s/${max_wait}s]" >&3
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "" >&3
  
  warn "$service did not become healthy within ${max_wait}s"
  warn "Logs from $service:"
  docker compose "${COMPOSE_ARGS_ARRAY[@]}" logs "$service" 2>&1 | tail -20 | sed 's/^/  /' >&3
  return 1
}

wait_started() {
  local service="$1"
  local max_wait="$2"
  local start_time
  start_time=$(date +%s)
  local elapsed=0
  
  log "Waiting for $service to start (max ${max_wait}s)..."
  while [ $elapsed -lt $max_wait ]; do
    if docker compose "${COMPOSE_ARGS_ARRAY[@]}" ps "$service" 2>/dev/null | grep -q "running\|Up"; then
      local duration
      duration=$(($(date +%s) - start_time))
      success "$service is running (took ${duration}s)"
      return 0
    fi
    printf "." >&3
    sleep 3
    elapsed=$((elapsed + 3))
  done
  echo "" >&3
  
  warn "$service did not start within ${max_wait}s"
  warn "Logs from $service:"
  docker compose "${COMPOSE_ARGS_ARRAY[@]}" logs "$service" 2>&1 | tail -20 | sed 's/^/  /' >&3
  return 1
}

# Wait for infrastructure (fail if these don't work)
if ! wait_healthy "postgres" 60; then
  fail "PostgreSQL failed to become healthy. Cannot proceed without database."
fi

if ! wait_healthy "redis" 30; then
  fail "Redis failed to become healthy. Cannot proceed without cache."
fi

# Wait for the Tyk gateway (the API depends on it)
if ! wait_started "tyk-gateway" 120; then
  warn "Tyk Gateway may have issues — check logs above"
fi

# Wait for the analytics pump (distroless, so "started" is all compose can tell us)
if ! wait_started "tyk-pump" 90; then
  warn "Tyk Pump did not start — analytics will report the pipeline as not ready"
fi

# Wait for API (fail if API doesn't start)
if ! wait_started "api" 90; then
  warn "API did not start within timeout"
  warn "This may be normal for first startup — will check endpoints"
fi

# Wait for Web
if ! wait_started "web" 90; then
  warn "Web did not start within timeout"
fi

# Ory services. Both of the fatal steps below depend on these being up, so waiting here turns a
# startup race into a wait: the seed publishes every membership tuple to Keto, and the Kratos import
# after it needs Kratos's admin API. Hydra is not waited on — nothing in the install path calls it.
if ! wait_healthy "keto" 60; then
  fail "Ory Keto failed to become healthy. Seeding publishes membership tuples to it, so it must be up."
fi

if ! wait_healthy "kratos" 60; then
  fail "Ory Kratos failed to become healthy. The admin identity import below needs its admin API."
fi

# ─── 10. Run Migrations ────────────────────────────────────────────────────
step "Running Database Migrations"

sleep 3

log "Applying migrations via Docker..."

MIGRATE_LOG="${LOG_DIR}/migration-$(date +%s).log"
if docker compose "${COMPOSE_ARGS_ARRAY[@]}" run --rm \
  -e "DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@postgres:5432/${DB_NAME}?schema=public" \
  api npx prisma migrate deploy --schema=/app/packages/database/prisma/schema.prisma > "$MIGRATE_LOG" 2>&1; then
  success "Database migrations applied"
elif grep -q "No new migrations to run" "$MIGRATE_LOG" 2>/dev/null; then
  log "Migrations already applied (idempotent)"
else
  error "Migration failed"
  error "Details:"
  tail -50 "$MIGRATE_LOG" | sed 's/^/  /' >&3
  fail "Cannot proceed without successful migration"
fi

# ─── 11. Seed Database ─────────────────────────────────────────────────────
step "Seeding Database"

log "Running seed script via Docker..."

# `prisma db seed` takes no --schema flag and reads the `prisma.seed` script from the package.json in
# the working directory, so it must run from /app/packages/database (tsx and prisma both ship in the
# image). Getting this wrong used to fail silently and leave an empty database — no roles, no admin —
# behind a "setup complete" banner, so a failure here is fatal.
SEED_LOG="${LOG_DIR}/seed-$(date +%s).log"
if docker compose "${COMPOSE_ARGS_ARRAY[@]}" run --rm \
  -e "DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@postgres:5432/${DB_NAME}?schema=public" \
  -w /app/packages/database \
  api npx prisma db seed > "$SEED_LOG" 2>&1; then
  success "Database seeded (roles, permissions and the default admin user)"
else
  error "Seeding failed — the database has no roles or admin user, so nobody could log in"
  error "Details:"
  tail -50 "$SEED_LOG" | sed 's/^/  /' >&3
  fail "Cannot proceed without a seeded database. Log: $SEED_LOG"
fi

# The seed writes the admin to Postgres, but Postgres is no longer where logins are checked — Kratos
# is. Without this import the installer would print working credentials for an account that cannot
# sign in, because Kratos has no identity for it. The script re-uses the seeded bcrypt hash as
# Kratos's `hashed_password`, so the password below stays correct; it is idempotent (it looks each
# email up in Kratos first), so re-running install.sh is safe.
#
# KRATOS_ADMIN_URL must be overridden: the script defaults to the host-published loopback address,
# and this runs INSIDE the compose network where Kratos's admin API is kratos:4434.
IMPORT_LOG="${LOG_DIR}/kratos-import-$(date +%s).log"
if docker compose "${COMPOSE_ARGS_ARRAY[@]}" run --rm \
  -e "DATABASE_URL=postgresql://${DB_USER}:${DB_PASS}@postgres:5432/${DB_NAME}?schema=public" \
  -e "KRATOS_ADMIN_URL=http://kratos:4434" \
  -w /app/packages/database \
  api npx tsx scripts/migrate-users-to-kratos.ts > "$IMPORT_LOG" 2>&1; then
  success "Admin identity imported into Ory Kratos (login enabled)"
else
  error "Importing users into Kratos failed — the seeded admin exists in Postgres but cannot log in"
  error "Details:"
  tail -50 "$IMPORT_LOG" | sed 's/^/  /' >&3
  fail "Cannot proceed without a Kratos identity for the admin. Log: $IMPORT_LOG"
fi

# ─── 12. Final Health Check ────────────────────────────────────────────────
step "Final Health Check"

check_url() {
  local url="$1"
  local name="$2"
  if curl -fsSL --max-time 10 --connect-timeout 5 "$url" > /dev/null 2>&1; then
    success "$name is responding"
    return 0
  else
    warn "$name is not responding yet (may still be starting)"
    return 1
  fi
}

sleep 5

API_HEALTH="http://localhost:${HOST_API}/api/health"
WEB_URL="http://localhost:${HOST_WEB}"

if check_url "$API_HEALTH" "API (localhost:${HOST_API})"; then
  API_STATUS="✅ Responding"
else
  API_STATUS="⚠️ Starting"
fi

if check_url "$WEB_URL" "Web (localhost:${HOST_WEB})"; then
  WEB_STATUS="✅ Responding"
else
  WEB_STATUS="⚠️ Starting"
fi

# ─── 13. Generate Summary ──────────────────────────────────────────────────
step "Installation Summary"

TOTAL_DURATION=$((SECONDS - SCRIPT_START_TIME))

# Create summary file
cat > "${LOG_DIR}/LAST_INSTALL.summary" <<EOF
Installation Date: $(date)
Install ID: $INSTALL_ID
Duration: $((TOTAL_DURATION / 60)) min $((TOTAL_DURATION % 60)) sec
Node Version: $(node -v)
pnpm Version: $(pnpm -v)
Docker Version: $(docker --version)
API Status: $API_STATUS
Web Status: $WEB_STATUS
Log File: $LOG_FILE
Status: SUCCESS
EOF

log "Installation complete in $((TOTAL_DURATION / 60)) min $((TOTAL_DURATION % 60)) sec"

# ─── 14. Final Output ──────────────────────────────────────────────────────
echo "" >&3
echo -e "${BOLD}${GREEN}" >&3
echo "╔══════════════════════════════════════════════════════════════╗" >&3
echo "║     🎉 MIRQAB Setup Complete! 🎉                            ║" >&3
echo "╚══════════════════════════════════════════════════════════════╝" >&3
echo -e "${NC}" >&3

echo -e "${BOLD} Services:${NC}" >&3
echo -e "  🌐 Web App:    ${CYAN}http://localhost:${HOST_WEB}${NC} ($WEB_STATUS)" >&3
echo -e "  🔌 API Server: ${CYAN}http://localhost:${HOST_API}/api/health${NC} ($API_STATUS)" >&3
echo -e "  🗄️ PostgreSQL:  ${CYAN}localhost:${HOST_DB}${NC}" >&3
echo -e "  ⚡ Redis:       ${CYAN}localhost:${HOST_REDIS}${NC}" >&3

echo -e "  🚀 Tyk Gateway: ${CYAN}http://localhost:${HOST_TYK_GW}/<listen-path>${NC} (API traffic)" >&3
echo -e "     Control API (/tyk/*) and /hello run on port 8081 inside the compose network only" >&3

echo "" >&3
echo -e "  🔐 Hydra:  ${CYAN}http://localhost:${HOST_HYDRA_PUBLIC}${NC} (public), ${CYAN}localhost:${HOST_HYDRA_ADMIN}${NC} (admin, loopback-only)" >&3
echo -e "  🔐 Kratos: ${CYAN}http://localhost:${HOST_KRATOS_PUBLIC}${NC} (public), ${CYAN}localhost:${HOST_KRATOS_ADMIN}${NC} (admin, loopback-only)" >&3
echo -e "  🔐 Keto:   ${CYAN}localhost:${HOST_KETO_READ}${NC} (read), ${CYAN}localhost:${HOST_KETO_WRITE}${NC} (write) — both loopback-only" >&3

echo "" >&3

echo -e "${BOLD} Development Credentials:${NC}" >&3
echo -e "  Email:    ${CYAN}admin@opengateway.io${NC}" >&3
echo -e "  Password: ${CYAN}Admin123!${NC}" >&3
echo -e "  ${YELLOW}Development only — change it after the first login. Production refuses this${NC}" >&3
echo -e "  ${YELLOW}login: set ADMIN_EMAIL / ADMIN_PASSWORD instead (docs/go-live.md).${NC}" >&3

echo "" >&3
echo -e "${BOLD} Quick Start Commands:${NC}" >&3
echo -e "  Start development: ${CYAN}pnpm dev${NC}" >&3
echo -e "  View logs:         ${CYAN}docker compose -f infra/docker-compose.yml --profile dev logs -f${NC}" >&3
echo -e "  Run tests:         ${CYAN}pnpm test${NC}" >&3
echo -e "  Prisma Studio:     ${CYAN}pnpm db:studio${NC}" >&3
echo -e "  Stop all:          ${CYAN}docker compose -f infra/docker-compose.yml --profile dev down${NC}" >&3

echo "" >&3
echo -e "${BOLD} Documentation:${NC}" >&3
echo -e "  📖 README: ${CYAN}README.md${NC}" >&3
echo -e "  🛠️ Dev Guide: ${CYAN}docs/development.md${NC}" >&3
echo -e "  🏗️ Architecture: ${CYAN}docs/architecture.md${NC}" >&3

echo "" >&3
echo -e "${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}" >&3
echo "" >&3
log "Install ID: $INSTALL_ID (save this for troubleshooting)"
log "Log file: $LOG_FILE"
log "Full log preserved for troubleshooting"
