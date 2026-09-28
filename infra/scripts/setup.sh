#!/usr/bin/env bash
set -euo pipefail

# ─── MIRQAB — Local Development Setup ──────────────
# This script bootstraps the local development environment.
# Usage: bash infra/scripts/setup.sh

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

log() { echo -e "${GREEN}[SETUP]${NC} $1"; }
warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
error() { echo -e "${RED}[ERROR]${NC} $1"; exit 1; }

# Check prerequisites
check_prerequisite() {
  local cmd="$1"
  local name="$2"
  if ! command -v "$cmd" &> /dev/null; then
    error "$name is not installed. Please install it first."
  fi
  log "$name is installed: $(command -v "$cmd")"
}

log "Starting MIRQAB local setup..."

# 1. Check prerequisites
log "Checking prerequisites..."
check_prerequisite "node" "Node.js"
check_prerequisite "pnpm" "pnpm"
check_prerequisite "docker" "Docker"
check_prerequisite "docker-compose" "Docker Compose" || check_prerequisite "docker compose" "Docker Compose"

NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  error "Node.js 20+ is required. Current version: $(node -v)"
fi

# 2. Install dependencies
log "Installing dependencies..."
pnpm install

# 3. Copy environment files
log "Setting up environment files..."
if [ ! -f apps/web/.env.local ]; then
  cp apps/web/.env.example apps/web/.env.local
  log "Created apps/web/.env.local from example"
else
  warn "apps/web/.env.local already exists, skipping"
fi

if [ ! -f apps/api/.env.local ]; then
  cp apps/api/.env.example apps/api/.env.local
  log "Created apps/api/.env.local from example"
else
  warn "apps/api/.env.local already exists, skipping"
fi

# 4. Start infrastructure
log "Starting PostgreSQL and Redis..."
docker compose -f infra/docker-compose.yml up -d postgres redis

# Wait for services to be healthy
log "Waiting for services to be healthy..."
sleep 5

# 5. Generate Prisma client
log "Generating Prisma client..."
pnpm db:generate

# 6. Run database migrations
log "Running database migrations..."
pnpm db:migrate:dev

# 7. Seed database
log "Seeding database..."
pnpm db:seed || warn "Database seeding skipped (no seed script yet)"

# 8. Summary
log ""
log "═══════════════════════════════════════════════════"
log "  Setup Complete! 🎉"
log "═══════════════════════════════════════════════════"
log ""
log "  Services:"
log "    PostgreSQL:  localhost:5432"
log "    Redis:       localhost:6379"
log ""
log "  Start development servers:"
log "    pnpm dev"
log ""
log "  Individual services:"
log "    pnpm --filter @open-gateway/web dev    (Next.js on :3000)"
log "    pnpm --filter @open-gateway/api dev    (NestJS on :4000)"
log "    pnpm db:studio                          (Prisma Studio on :5555)"
log ""
log "═══════════════════════════════════════════════════"
