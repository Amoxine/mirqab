#!/usr/bin/env bash
# ============================================================================
# MIRQAB — Stack Rebuild Script
# ============================================================================
# Rebuilds and recreates the Docker Compose stack (infra/docker-compose.yml).
#
# Usage:
#   bash rebuild.sh                 # Interactive: choose all or specific services
#   bash rebuild.sh --all           # Non-interactive: rebuild everything
#   bash rebuild.sh api web         # Non-interactive: rebuild just these services
#
# `docker compose build` is a no-op for services with no `build:` context
# (postgres/redis/hydra/kratos/keto/tyk-*  pull pinned images) — it's safe to
# pass every service through the same build+up pipeline regardless.
#
# Never runs `down -v` or touches volumes: this only builds and recreates
# containers, so postgres/redis/tyk_apps data is never at risk.
# ============================================================================

set -euo pipefail

# ─── Colors ─────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

log() { echo -e "${GREEN}[$(date +'%H:%M:%S')]${NC} $1"; }
warn() { echo -e "${YELLOW}[$(date +'%H:%M:%S')] [WARN]${NC} $1"; }
error() { echo -e "${RED}[$(date +'%H:%M:%S')] [ERROR]${NC} $1"; }
step() { echo -e "\n${BOLD}${CYAN}━━━ $1 ━━━${NC}"; }
success() { echo -e "${GREEN}✅ $1${NC}"; }
fail() { error "$1"; exit 1; }

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")" && pwd)"
COMPOSE_FILE="${SCRIPT_DIR}/infra/docker-compose.yml"
COMPOSE_ARGS=(-f "$COMPOSE_FILE")

[ -f "$COMPOSE_FILE" ] || fail "Compose file not found: $COMPOSE_FILE"
command -v docker &>/dev/null || fail "docker is not installed or not on PATH"

# ─── 1. Discover services ───────────────────────────────────────────────────
mapfile -t ALL_SERVICES < <(docker compose "${COMPOSE_ARGS[@]}" config --services | sort)
[ "${#ALL_SERVICES[@]}" -gt 0 ] || fail "No services found in $COMPOSE_FILE"

# ─── 2. Decide which services to rebuild ────────────────────────────────────
SELECTED=()

if [ $# -gt 0 ]; then
  if [ "$1" = "--all" ]; then
    SELECTED=("${ALL_SERVICES[@]}")
  else
    SELECTED=("$@")
  fi
else
  step "MIRQAB — Stack Rebuild"
  echo "Services:"
  for i in "${!ALL_SERVICES[@]}"; do
    printf "  %2d) %s\n" "$((i + 1))" "${ALL_SERVICES[$i]}"
  done
  echo ""
  echo "Enter 'all', or a space/comma-separated list of numbers or names (e.g. \"1 3\" or \"api web\"):"
  read -r -p "> " ANSWER

  if [ -z "$ANSWER" ] || [ "$ANSWER" = "all" ]; then
    SELECTED=("${ALL_SERVICES[@]}")
  else
    ANSWER="${ANSWER//,/ }"
    for token in $ANSWER; do
      if [[ "$token" =~ ^[0-9]+$ ]] && [ "$token" -ge 1 ] && [ "$token" -le "${#ALL_SERVICES[@]}" ]; then
        SELECTED+=("${ALL_SERVICES[$((token - 1))]}")
      elif printf '%s\n' "${ALL_SERVICES[@]}" | grep -qx "$token"; then
        SELECTED+=("$token")
      else
        warn "Ignoring unrecognized service/number: $token"
      fi
    done
  fi
fi

[ "${#SELECTED[@]}" -gt 0 ] || fail "No valid services selected"

step "Selected: ${SELECTED[*]}"

# ─── 3. Build ────────────────────────────────────────────────────────────────
step "Building"
docker compose "${COMPOSE_ARGS[@]}" build "${SELECTED[@]}"
success "Build complete"

# ─── 4. Recreate ─────────────────────────────────────────────────────────────
step "Recreating containers"
docker compose "${COMPOSE_ARGS[@]}" up -d "${SELECTED[@]}"
success "Containers recreated"

# ─── 5. Wait for health where a healthcheck exists ──────────────────────────
step "Waiting for health"
for svc in "${SELECTED[@]}"; do
  has_healthcheck=$(docker compose "${COMPOSE_ARGS[@]}" config "$svc" 2>/dev/null | grep -c "healthcheck:" || true)
  if [ "$has_healthcheck" -eq 0 ]; then
    log "$svc has no healthcheck configured — skipping wait"
    continue
  fi
  log "Waiting for $svc to be healthy (max 60s)..."
  elapsed=0
  ok=false
  while [ $elapsed -lt 60 ]; do
    if docker compose "${COMPOSE_ARGS[@]}" ps "$svc" 2>/dev/null | grep -qE '\(healthy\)'; then
      ok=true
      break
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done
  if [ "$ok" = true ]; then
    success "$svc is healthy"
  else
    warn "$svc did not report healthy within 60s — check: docker compose ${COMPOSE_ARGS[*]} logs $svc"
  fi
done

step "Done"
docker compose "${COMPOSE_ARGS[@]}" ps "${SELECTED[@]}"
