# Open Gateway — SaaS Admin Dashboard for Tyk OSS

> Production-ready monorepo for managing Tyk API Gateway instances through a modern admin dashboard.

[![CI](https://github.com/open-gateway/open-gateway/actions/workflows/ci.yml/badge.svg)](https://github.com/open-gateway/open-gateway/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-%3E%3D20.0-339933)](https://nodejs.org/)
[![pnpm](https://img.shields.io/badge/pnpm-10.4-f69220)](https://pnpm.io/)

## What is Open Gateway?

Open Gateway is a **production-grade SaaS admin dashboard** built as a monorepo, designed to manage [Tyk OSS](https://tyk.io/) API Gateway instances. It provides a modern web interface for:

- **Multi-tenant API management** — Create, update, and sync API definitions to Tyk Gateway
- **API key lifecycle** — Generate, assign, revoke keys with per-key quotas
- **Tenant isolation** — Role-based access control with per-tenant data scoping
- **Audit compliance** — Immutable, append-only audit log for every action
- **Analytics dashboard** — Request metrics, latency tracking, usage trends
- **Enterprise security** — 5-layer defense-in-depth, circuit breakers, rate limiting

The **Next.js frontend** never talks to Tyk directly. Only the **NestJS backend** holds Tyk credentials, sanitizes all responses, and implements circuit breakers for resilience.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         EXTERNAL WORLD                              │
│                                                                     │
│  ┌────────────┐    ┌──────────────┐    ┌──────────────────────┐    │
│  │  Browser   │    │ Tyk Gateway  │    │ Tyk Gateway REST API │    │
│  │ (Admin UI) │    │  (Traffic)   │    │    (REST API)        │    │
│  └─────┬──────┘    └──────┬───────┘    └──────────┬───────────┘    │
│        │                  │                       │                 │
│        │  HTTPS           │  API Traffic          │ Admin API       │
│        │                  │                       │ (REST)          │
│        ▼                  ▼                       ▼                 │
├────────┼──────────────────┼───────────────────────┼─────────────────┤
│        │                  │                       │                 │
│  ┌─────▼──────┐           │               ┌───────▼───────────┐     │
│  │ Next.js 15 │           │               │    NestJS 11      │     │
│  │  (Web App) │───────────┼──────────────►│    (API Server)   │     │
│  │            │  REST/    │  ONLY NestJS  │                   │     │
│  │ - SSR      │  JSON     │  calls Tyk    │ - Auth (JWT)      │     │
│  │ - Dashboard│           │               │ - API CRUD        │     │
│  │ - Tables   │           │               │ - Key management  │     │
│  │ - Forms    │           │               │ - Tyk proxy       │     │
│  │ - Analytics│           │               │ - Audit logging   │     │
│  └─────┬──────┘           │               └───────┬───────────┘     │
│        │                  │                       │                 │
│        │                  │               ┌───────▼───────────┐     │
│        │                  │               │   PostgreSQL 16   │     │
│        │                  │               │   + Prisma 6      │     │
│        │                  │               │                   │     │
│        │                  │               │ - Users & Roles   │     │
│        │                  │               │ - Tenants         │     │
│        │                  │               │ - API definitions │     │
│        │                  │               │ - API keys        │     │
│        │                  │               │ - Quotas          │     │
│        │                  │               │ - Audit logs      │     │
│        │                  │               └───────────────────┘     │
│        │                  │                                         │
│        │                  │               ┌───────────────────┐     │
│        │                  │               │     Redis 7       │     │
│        │                  │               │                   │     │
│        │                  │               │ - Cache           │     │
│        │                  │               │ - Rate limiting   │     │
│        │                  │               │ - Sessions        │     │
│        │                  │               │ - Pub/Sub         │     │
│        │                  │               └───────────────────┘     │
│        │                  │                                         │
├────────┴──────────────────┴─────────────────────────────────────────┤
│                        OBSERVABILITY                                │
│  ┌──────────────────────────────────────────────────────────────┐   │
│  │  OpenTelemetry → Prometheus + Grafana + Loki + Tempo         │   │
│  └──────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

Auth is **Ory** now, running as its own set of compose services alongside Postgres/Redis (not drawn
above): **Hydra** issues OAuth2/OIDC access tokens, **Kratos** owns login/registration/recovery, and
**Keto** answers "does this user belong to this tenant". The NestJS API verifies Hydra's tokens
against its JWKS and signs nothing itself. See [Security → JWT Security](docs/security.md#jwt-security)
for the full picture.

---

## Tech Stack

| Layer | Technology | Version |
|-------|-----------|---------|
| **Frontend** | Next.js (App Router) | 15.x |
| **Frontend** | React | 19.x |
| **Frontend** | TypeScript | 5.8.x |
| **Styling** | Tailwind CSS | 4.x |
| **UI Components** | shadcn/ui | latest |
| **State Management** | TanStack Query | 5.x |
| **Data Tables** | TanStack Table | 8.x |
| **Forms** | React Hook Form | 7.x |
| **Validation** | Zod | 3.x |
| **Backend** | NestJS | 11.x |
| **Backend** | Express (via NestJS) | 4.x |
| **ORM** | Prisma | 6.x |
| **Database** | PostgreSQL | 16.x |
| **Cache** | Redis | 7.x |
| **Security** | Helmet, Ory Hydra/Kratos/Keto | - |
| **Monitoring** | OpenTelemetry | latest |
| **Monorepo** | pnpm workspaces | 10.4.x |
| **Build Orchestration** | Turborepo | 2.5.x |
| **Linting** | ESLint 9 (flat config) | 9.x |
| **Formatting** | Prettier | 3.5.x |
| **Infrastructure** | Docker Compose | v2 |
| **CI/CD** | GitHub Actions | - |

---

## Quick Start

### One-Command Full Stack Install

```bash
bash install.sh
```

This single command will:
1. ✅ Check prerequisites (Node.js 20+, pnpm, Docker)
2. 📦 Install all dependencies via pnpm
3. 🔐 Generate secure secrets (DB password, Tyk gateway secret, Ory Hydra/Kratos — `JWT_SECRET` is also generated but no longer used to sign anything, see [Security](docs/security.md))
4. 📝 Create `.env.local` files for all services
5. 🐳 Start the full stack via Docker Compose (Postgres, Redis, Tyk Gateway, Ory Hydra/Kratos/Keto, API, Web)
6. 🗄️ Generate Prisma client and run migrations
7. 🌱 Seed default data (admin user, roles, permissions, Keto tenant tuples)
8. 🔨 Build all packages
9. 🚀 Start API and Web servers
10. 🏥 Run health checks on all services

**Optional flags:**
```bash
bash install.sh --non-interactive   # Automated install (no prompts)
bash install.sh --debug             # Enable trace mode for troubleshooting
bash install.sh --verbose           # Show full command output
```

**Access the application:** every application port is HTTPS, terminated by the Caddy edge, which is
the only container that publishes one. It signs with its own internal CA, so install that root once
per client machine or every request needs `-k` — [`infra/edge/README.md`](infra/edge/README.md).

- **Web App**: https://localhost:33000
- **API**: https://localhost:33001/api/health
- **Prisma Studio**: http://localhost:33004
- **Tyk Gateway** (open-source, no Tyk Dashboard): https://localhost:33005/`<listen-path>` — API traffic only.
  The gateway's control API (`/tyk/*`) **and** `/hello` run on port 8081, which is not published to the
  host; only the API container reaches them. Postgres (33002) and Redis (33003) are bound to `127.0.0.1`.

**Credentials:** `admin@opengateway.io` / `Admin123!` — a development default; change it after the
first login. **Login goes through Ory Kratos**, not Postgres, so the seeded row alone is not enough:
`install.sh` runs `packages/database/scripts/migrate-users-to-kratos.ts` immediately after seeding,
which creates the matching Kratos identity. The import re-uses the seeded bcrypt hash as Kratos's
`hashed_password`, so the password above is the one that works (see `docs/security.md`'s Password
Policy section).

If you set the stack up by hand rather than through `install.sh`, run that import yourself once the
stack is up, or the admin will exist in Postgres and be unable to sign in:
```bash
docker compose -f infra/docker-compose.yml run --rm \
  -e KRATOS_ADMIN_URL=http://kratos:4434 -w /app/packages/database \
  api npx tsx scripts/migrate-users-to-kratos.ts
```
It is idempotent (it looks each email up in Kratos first), so re-running it — or re-running
`install.sh` — is safe. Note that Kratos would *reject* `Admin123!` at self-service registration
("too similar to the identifier"); the import path bypasses that policy by carrying the hash over
directly, which is why this is an import and not a scripted sign-up.

### Manual Setup

If you prefer step-by-step setup:

```bash
# 1. Install dependencies
pnpm install

# 2. Copy environment files
cp apps/web/.env.example apps/web/.env.local
cp apps/api/.env.example apps/api/.env.local

# 3. Start infrastructure (PostgreSQL + Redis)
pnpm infra:up

# 4. Setup database
pnpm db:generate
pnpm db:migrate:dev
pnpm db:seed

# 5. Start all services
pnpm dev
```

---

## Installation

### Prerequisites

| Tool | Min Version | How to Install |
|------|-------------|----------------|
| Node.js | 20.x | https://nodejs.org/ |
| pnpm | 9.x | `corepack enable && corepack prepare pnpm@latest --activate` |
| Docker | 20.x | https://docs.docker.com/get-docker/ |
| Docker Compose | v2 | Included with Docker Desktop |

> **Note:** Corepack must be available (Node.js 16.13+). The installer will fail with a clear error if it's missing.

### Available Flags

| Flag | Description |
|------|-------------|
| `--non-interactive` | Skip all prompts, use secure defaults. Ideal for CI/CD. |
| `--debug` | Enable `set -x` trace mode. Writes full trace to log file. |
| `--verbose` | Show full command output instead of summary last-3-lines. |

```bash
bash install.sh --non-interactive             # Automated full-stack install
bash install.sh --debug 2>&1 | tee debug.log   # Full trace for troubleshooting
```

### What Gets Installed

The installer performs these steps in order:

1. **Validates prerequisites** — Node.js 20+, pnpm 9+, Docker, Docker Compose v2
2. **Pre-flight checks** — port availability (33000–33003 and 33005), disk space (requires 5 GB+), `.gitignore` check
3. **Generates secure credentials** — DB password, Tyk gateway secret, and Ory Hydra/Kratos secrets via `openssl rand` (written to `infra/.env`, read by docker compose). A `JWT_SECRET` is also generated for compose's benefit only — no code reads it any more; see [Security](docs/security.md)
4. **Creates `.env.local` files** — with `chmod 600` permissions (owner read-only); never committed
5. **Installs dependencies** — `pnpm install --frozen-lockfile` with workspace integrity check
6. **Builds apps** — API and Web apps (warns if Web build exceeds 500 MB)
7. **Generates Prisma client** — from `packages/database/prisma/schema.prisma`
8. **Starts services** — `docker compose up -d --build` (Postgres, Redis, Tyk OSS Gateway, Ory Hydra/Kratos/Keto, API, Web)
9. **Waits for health** — PostgreSQL (60 s), Redis (30 s), API (90 s), Web (90 s)
10. **Runs migrations** — `prisma migrate deploy` inside the API container
11. **Seeds database** — admin user, roles, permissions, and Keto tenant-membership tuples (idempotent). This does **not** create the admin's Ory Kratos identity — see the Credentials note above
12. **Final health check** — hits `/api/health` and the web root; prints access URLs

### Troubleshooting

**Finding your install log**

Each run creates a timestamped log in `.install-logs/` and a unique **Install ID**:

```bash
ls -lt .install-logs/                  # Most recent log first
cat .install-logs/LAST_INSTALL.summary # Quick status from last run
```

**Using the Install ID**

The Install ID is printed at start and end of every run. Use it to grep a specific run:

```bash
# Example: grep f70925d0 .install-logs/install-*.log
grep "<install-id>" .install-logs/install-*.log
```

**Common errors**

| Error | Cause | Fix |
|-------|-------|-----|
| `Corepack not available` | Node.js < 16.13 | Upgrade Node.js to 20+ |
| `Port XXXXX already in use` | Conflicting service | `lsof -i :33000` to find and stop it |
| `Less than 5GB free` | Low disk space | Free space; Docker images need ~8 GB |
| `Docker is not running` | Docker daemon stopped | `sudo systemctl start docker` |
| `pnpm 9.0.0+ required` | Outdated pnpm | `corepack prepare pnpm@latest --activate` |
| `Failed to install dependencies` | Lockfile mismatch | `pnpm clean && bash install.sh` |

**Re-running after a failure**

Safe to re-run: an existing `infra/.env` is **edited, not rewritten**. Every line already in it
survives byte for byte — including keys `install.sh` does not manage, like `TYK_ADMIN_URLS` for the
multinode profile, `KRATOS_SMTP_URI` for real mail, and the `EDGE_IMAGE`/`API_IMAGE`/`WEB_IMAGE`
pins the prod overlay reads — and only keys the file is missing are appended.

```bash
bash install.sh                        # Re-run normally
bash install.sh --debug                # Re-run with full trace output
```

This was not always true. Until it was fixed, every re-run minted fresh values and truncated the
file, so a second run rotated every credential *and* dropped every hand-set line — see the rotation
table under **Security Notes** for what that costs per secret.

One constraint comes with it: a managed key has to be written as plain `KEY=value`, with a value. An
`export` prefix, indentation, spaces around `=`, quotes, a trailing space or CR — or an empty value —
make the line unusable to the installer, and it stops with the key and line number rather than
treating the secret as missing and regenerating it. Compose accepts most of those forms, which is
exactly why the mismatch was worth failing on instead of guessing. To regenerate a key, delete its
line rather than blanking it.

### Security Notes

- **Secrets are auto-generated** on the first install using `openssl rand` (32-byte entropy), and
  **reused** on every run after that
- **`.env.local` files** are created with `chmod 600` — readable only by the file owner
- **Secrets are never logged** — they appear only in `.env.local` files

**`infra/.env` is the source of truth.** `apps/api/.env.local` and `apps/web/.env.local` are
*derived* from it (the database URL, the gateway secret), so deleting those two rotates nothing —
they are rebuilt with the same values. Rotation means deleting the key from `infra/.env`:

```bash
# Rotate ONE secret — delete just that line, then re-run
sed -i '/^KRATOS_SECRETS_COOKIE=/d' infra/.env
bash install.sh --non-interactive
```

**Read the table before rotating anything.** Deleting a key regenerates it, and for most of these
that invalidates state the stack has already written. `rm infra/.env` rotates *everything* and is
almost never what you want:

| Secret | Rotating it against an existing stack |
|---|---|
| `DB_PASS` | **Breaks the stack.** `POSTGRES_PASSWORD` applies only when the volume is first initialised, so Postgres keeps demanding the old password while the app is handed a new one. Requires `ALTER USER opengateway PASSWORD '<new>'` inside the running database, or a wiped volume. Verified on a scratch volume. |
| `HYDRA_SECRETS_SYSTEM` | **Breaks existing data.** Hydra encrypts stored OAuth2 clients and tokens with it, and `hydra.yml` passes one value with no rotation list, so previously encrypted rows become undecryptable. |
| `KRATOS_SECRETS_CIPHER` | **Breaks existing data.** Kratos encrypts identity credential fields with it; same single-value wiring, same consequence. |
| `HYDRA_SECRETS_COOKIE`, `KRATOS_SECRETS_DEFAULT`, `KRATOS_SECRETS_COOKIE` | Logs everyone out and invalidates in-flight login/consent and recovery flows. Recoverable by signing in again. |
| `TYK_WEBHOOK_RELAY_SECRET` | Breaks webhooks silently until every API is re-synced. The value is embedded *into each Tyk API definition* as an event-handler header (`webhook-relay.constants.ts`), so definitions already on the gateway keep presenting the old one and the relay rejects them — fail closed, no forged events, but no deliveries either. |
| `TYK_GW_SECRET`, `REDIS_PASSWORD` | Safe. Nothing persists keyed on them; compose hands the same value to every container that needs it, so they agree again after `docker compose up -d`. |
| `JWT_SECRET` | Safe — dead since the Ory cutover. The app signs nothing (`apps/api/src/modules/auth/jwt-secret.ts`); tokens are Hydra's and are verified against Hydra's JWKS. |

---

## Project Structure

```
open-gateway/
├── apps/
│   ├── web/                          # Next.js 15 frontend (App Router)
│   │   ├── src/
│   │   │   ├── app/                  # App Router pages & layouts
│   │   │   │   ├── (auth)/           # Ory Kratos/Hydra flows: login, register, recovery, verification, settings
│   │   │   │   └── (dashboard)/      # Dashboard route group
│   │   │   │       ├── analytics/    # Analytics page
│   │   │   │       ├── apis/         # API definitions management
│   │   │   │       ├── audit-logs/   # Audit log viewer
│   │   │   │       ├── keys/         # API key management
│   │   │   │       └── tenants/      # Tenant management
│   │   │   ├── components/           # React components
│   │   │   │   ├── ui/               # 21 shadcn/ui primitives
│   │   │   │   ├── layout/           # Layout components
│   │   │   │   └── providers/        # Context providers
│   │   │   ├── hooks/                # Custom React hooks (4 hooks)
│   │   │   ├── lib/                  # Utilities (API client, query keys)
│   │   │   ├── styles/               # Global CSS, Tailwind config
│   │   │   └── types/                # TypeScript types
│   │   ├── Dockerfile                # Multi-stage production build
│   │   └── package.json
│   │
│   └── api/                          # NestJS 11 backend
│       ├── src/
│       │   ├── modules/              # 8 feature modules
│       │   │   ├── auth/             # GET /auth/me only — verifies Hydra tokens, resolves session from Postgres + Keto; login/register/refresh are Ory's now
│       │   │   ├── tenants/          # Tenant CRUD, user mapping
│       │   │   ├── api-management/   # API definition CRUD + Tyk sync
│       │   │   ├── tyk-integration/  # Tyk Admin API client
│       │   │   ├── keys/             # API key lifecycle
│       │   │   ├── quotas/           # Per-key quota management
│       │   │   ├── analytics/        # Usage metrics, dashboards
│       │   │   └── audit/            # Append-only audit log
│       │   ├── common/               # Shared infrastructure
│       │   │   ├── cache/            # Caching interceptor
│       │   │   ├── circuit-breaker/  # Circuit breaker pattern
│       │   │   ├── decorators/       # Custom decorators
│       │   │   ├── filters/          # Exception filters
│       │   │   ├── guards/           # Auth & tenant guards
│       │   │   ├── interceptors/     # Request/response interceptors
│       │   │   ├── middleware/       # HTTP middleware
│       │   │   ├── redis/            # Redis client
│       │   │   └── types/            # Shared TypeScript types
│       │   ├── app.module.ts         # Root module
│       │   ├── app.controller.ts     # Health check endpoints
│       │   ├── app.service.ts        # Health check service
│       │   └── main.ts               # Bootstrap (port 4000)
│       ├── Dockerfile                # Multi-stage production build
│       └── package.json
│
├── packages/
│   ├── ui/                           # Shared UI components (shadcn/ui base)
│   ├── config/                       # Shared ESLint, Prettier, Tailwind, TS configs
│   ├── types/                        # Shared TypeScript types and DTOs
│   └── database/                     # Prisma schema, migrations, seed
│       ├── prisma/
│       │   ├── schema.prisma         # 10 data models
│       │   ├── migrations/           # Migration history
│       │   └── seed.ts               # Idempotent seed script
│       └── src/
│           └── index.ts              # Re-exports PrismaClient
│
├── infra/                            # Infrastructure
│   ├── docker-compose.yml            # PostgreSQL, Redis, API, Web
│   └── scripts/
│       └── setup.sh                  # One-command dev setup
│
├── docs/                             # Documentation
│   ├── architecture.md               # System design & ADRs
│   ├── development.md                # Developer guide
│   ├── deployment.md                 # Production deployment
│   └── security.md                   # Security architecture
│
├── .github/                          # CI/CD
│   ├── workflows/
│   │   ├── ci.yml                    # Lint, typecheck, test, build
│   │   └── dependabot.yml            # Automated dependency updates
│
├── package.json                      # Root workspace config
├── pnpm-workspace.yaml               # Workspace patterns
├── turbo.json                        # Turborepo pipeline
├── tsconfig.json                     # Base TypeScript config
├── eslint.config.js                  # ESLint 9 flat config
├── .prettierrc                       # Prettier config
└── SISYPHUS_PLAN.md                  # Historical planning doc (superseded, see docs/architecture.md)
```

---

## Commands

### Development

| Command | Description |
|---------|-------------|
| `pnpm dev` | Start all services in development mode (watch mode) |
| `pnpm build` | Build all packages and apps for production |
| `pnpm start` | Start all services in production mode |
| `pnpm lint` | Run ESLint across all packages |
| `pnpm lint:fix` | Run ESLint with auto-fix |
| `pnpm format` | Format all files with Prettier |
| `pnpm format:check` | Check formatting without writing |
| `pnpm typecheck` | Run TypeScript type checking across all packages |
| `pnpm test` | Run test suites across all packages |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm clean` | Clean build artifacts and node_modules |

### Database

| Command | Description |
|---------|-------------|
| `pnpm db:generate` | Generate Prisma client from schema |
| `pnpm db:migrate:dev` | Run development migrations (creates migration files) |
| `pnpm db:migrate` | Run production migrations (no file creation) |
| `pnpm db:seed` | Seed database with default data |
| `pnpm db:studio` | Open Prisma Studio (http://localhost:33004) |
| `pnpm db:reset` | Reset database (drops and recreates) |

### Infrastructure

| Command | Description |
|---------|-------------|
| `pnpm infra:up` | Start PostgreSQL and Redis via Docker Compose |
| `pnpm infra:down` | Stop all Docker services |
| `pnpm infra:logs` | Tail Docker Compose logs |

### Setup

| Command | Description |
|---------|-------------|
| `pnpm setup` | Run one-command setup script (`bash infra/scripts/setup.sh`) |

---

## Environment Variables

### API (`apps/api/.env.local`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | No | `development` | Runtime environment (`development`, `production`, `test`) |
| `PORT` | No | `4000` | HTTP port for the API server |
| `DATABASE_URL` | **Yes** | - | PostgreSQL connection string (e.g., `postgresql://user:pass@host:33002/db`) |
| `REDIS_URL` | **Yes** | - | Redis connection string (e.g., `redis://host:33003`) |
| `JWT_SECRET` | **Yes**, but unused | - | Leftover from the pre-Ory auth system. Compose still refuses to start the API without it, but nothing in the API reads it: access tokens are issued by Ory Hydra and verified against its JWKS, not signed here. See [Security](docs/security.md) |
| `JWT_EXPIRES_IN` | No | `15m` | Leftover, unread by any code path today. The real access-token TTL is Hydra's `ttl.access_token` (1h, `infra/ory/hydra/hydra.yml`) |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Leftover, unread by any code path today. The real refresh-token TTL is Hydra's `ttl.refresh_token` (720h) |
| `ORY_HYDRA_PUBLIC_URL` | **Yes** | `http://hydra:4444` | Where the API fetches Hydra's JWKS from (in-network URL) |
| `ORY_HYDRA_ISSUER` | **Yes** | `https://localhost:33010/` | The `iss` claim Hydra stamps into every token (the browser-facing URL) — **not** the same as `ORY_HYDRA_PUBLIC_URL` above |
| `ORY_HYDRA_ADMIN_URL` | No | - | Hydra's admin API, used for OAuth2 client management (data-plane `client_credentials` clients) |
| `ORY_KRATOS_PUBLIC_URL` / `ORY_KRATOS_ADMIN_URL` | No | - | Kratos public/admin API base URLs |
| `ORY_KETO_READ_URL` / `ORY_KETO_WRITE_URL` | **Yes** | `http://keto:4466` / `http://keto:4467` | Tenant-membership checks (`ketoCheck`) and tuple writes |
| `CORS_ORIGINS` | No | `https://localhost:33000` | Comma-separated allowed origins |
| `TYK_ADMIN_URL` | **Yes** | - | Tyk **Gateway** REST API base URL, i.e. `<gateway>/tyk` on its control port (`http://tyk-gateway:8081/tyk` in compose). Only the open-source gateway is supported, not the Tyk Dashboard |
| `TYK_ADMIN_SECRET` | **Yes** | - | Gateway secret (`TYK_GW_SECRET` on the gateway), sent as `x-tyk-authorization` |
| `TYK_GATEWAY_URL` | No | - | Base URL used for the `/hello` health probe. With a control port configured, `/hello` is served there, so this points at the control port too (`http://tyk-gateway:8081`) |
| `TYK_ORG_ID` | No | - | Tyk Organization ID for multi-org setups |
| `PROXY_DENY_HOSTS` | No | - | Extra upstream hosts an API may never proxy to, comma separated. On top of the built-in denylist: loopback, `0.0.0.0/8`, link-local / cloud metadata (`169.254.0.0/16`, `fe80::/10`, `metadata`, `metadata.google.internal`) and the platform's own services (`tyk-gateway`, `tyk-pump`, `postgres`, `redis`). Internal service names and RFC1918 addresses stay allowed |
| `PUMP_HEALTH_URL` | No | - | Tyk Pump liveness probe (`http://tyk-pump:8083/health` in compose). Unset or unreachable = analytics report the pipeline as not ready |
| `ANALYTICS_RETENTION_DAYS` | No | `30` | Daily trim of the pump's raw request table |
| `ANALYTICS_AGGREGATE_RETENTION_DAYS` | No | `365` | Daily trim of the pump's hourly aggregate table |

### Web (`apps/web/.env.local`)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEXT_PUBLIC_APP_URL` | No | `https://localhost:33000` | Base URL for the web app |
| `NEXT_PUBLIC_API_URL` | **Yes** | - | Backend API base URL (e.g., `https://localhost:33001/api`) |
| `NEXT_PUBLIC_KRATOS_URL` | **Yes** | `https://localhost:33012` | Browser-facing Kratos URL — the browser calls Kratos directly for login/register/recovery |
| `NEXT_PUBLIC_HYDRA_URL` | **Yes** | `https://localhost:33010` | Browser-facing Hydra URL, for the OAuth2 authorize redirect |
| `HYDRA_PUBLIC_URL` / `HYDRA_ADMIN_URL` / `KRATOS_INTERNAL_URL` | **Yes** | in-network defaults | This Next.js server's own outbound calls (login-challenge handling, token exchange) — distinct from the `NEXT_PUBLIC_*` pair above, which the browser uses |
| `COOKIE_SECURE` | No | `NODE_ENV === 'production'` | Overrides the `Secure` flag on the session cookies **this app sets** — the NestJS API no longer sets any auth cookie itself |

---

## API Endpoints Overview

All endpoints are prefixed with `/api` (configured via `app.setGlobalPrefix('api')`).

### Health & Root

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/` | Root health check | No |
| `GET` | `/health` | Detailed health check | No |

### Authentication (`/auth`)

Login, registration, recovery and refresh are **not** REST endpoints on this API any more — they are
Ory Kratos/Hydra flows, fronted by pages and routes in `apps/web` (`(auth)/auth/*` and `oauth2/*`).
This API's `/auth` namespace only has one route left:

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/auth/me` | Get current session's user, roles, permissions and tenants (resolved fresh from Postgres + Keto on every call) | Yes |

### Tenants (`/tenants`)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/tenants` | List all tenants (paginated) | Yes |
| `GET` | `/tenants/:id` | Get tenant by ID | Yes |
| `POST` | `/tenants` | Create new tenant | Yes |
| `PATCH` | `/tenants/:id` | Update tenant | Yes |
| `DELETE` | `/tenants/:id` | Delete tenant | Yes |
| `GET` | `/tenants/:id/users` | List the tenant's users | Yes |
| `POST` | `/tenants/:id/users` | Add a user to the tenant | Yes |

### API Management (`/apis`)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/apis` | List API definitions (paginated, filtered) | Yes |
| `GET` | `/apis/:id` | Get API definition by ID | Yes |
| `POST` | `/apis` | Create API definition + sync to Tyk | Yes |
| `PATCH` | `/apis/:id` | Update API definition (or set `status`) + sync to Tyk | Yes |
| `DELETE` | `/apis/:id` | **Delete** the API definition (hard delete) and remove it from Tyk. Refused with `409` while ACTIVE keys still reference it; `502` if the gateway copy cannot be removed (the row is kept) | Yes |
| `POST` | `/apis/:id/sync` | Re-push the definition to the gateway now and return the resulting `syncStatus` | Yes |

`POST`/`PATCH` answer `409` when the `slug` is taken inside the tenant, or when the `listenPath` is
already registered **by any tenant** (listen paths are globally unique), and `400` when `proxyUrl`
points at a denylisted host (loopback, link-local / cloud metadata, a platform service, `PROXY_DENY_HOSTS`).

### Gateway (`/gateway`)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/gateway/status` | Gateway reachability, version, Redis state, latency and circuit-breaker state | Yes |

### API Keys (`/keys`)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/keys` | List API keys (paginated; `page` >= 1, `pageSize` clamped to 1..100) | Yes |
| `GET` | `/keys/:id` | Get API key by ID, with its live gateway limits | Yes |
| `POST` | `/keys` | Create API key in Tyk (raw key returned once) | Yes |
| `PATCH` | `/keys/:id` | Update name, expiry, rate limit or quota (`409` unless the key is ACTIVE) | Yes |
| `POST` | `/keys/:id/revoke` | Revoke API key (removes it from Tyk) | Yes |
| `GET` | `/keys/:id/usage` | Key usage and quota status | Yes |

### Analytics (`/analytics`)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/analytics/overview` | Get analytics overview (requests, latency, etc.) | Yes |
| `GET` | `/analytics/timeseries` | Get time-series data for a metric | Yes |
| `GET` | `/analytics/apis` | Get per-API usage statistics | Yes |
| `GET` | `/analytics/keys` | Get per-key usage statistics | Yes |
| `GET` | `/analytics/top-apis` | Busiest APIs over the range | Yes |
| `GET` | `/analytics/status-codes` | Response-code breakdown | Yes |
| `GET` | `/analytics/health` | Analytics pipeline health (gateway analytics + pump reachability) | Yes |

### Audit Logs (`/audit-logs`)

| Method | Path | Description | Auth |
|--------|------|-------------|------|
| `GET` | `/audit-logs` | List audit log entries (paginated, filtered) | Yes |
| `GET` | `/audit-logs/stats` | Aggregated counts per action / resource | Yes |
| `GET` | `/audit-logs/export/csv` | Download the filtered entries as CSV | Yes |
| `GET` | `/audit-logs/:id` | Get a single audit log entry | Yes |

> There is no `/quotas` REST surface: quotas are set through `POST`/`PATCH /keys` and enforced by the
> gateway. The `Quota` model and `QuotaService` are vestigial local bookkeeping.

---

## Database Models Overview

Open Gateway uses **Prisma 6** with **PostgreSQL 16**. The schema defines **10 models**:

| Model | Description | Key Fields |
|-------|-------------|------------|
| **User** | System users; identity/auth now lives in Ory Kratos | `email`, `name`, `password` (bcrypt — vestigial, not read by the live login path), `status`, `kratosIdentityId` |
| **Tenant** | Multi-tenant organization units | `name`, `slug`, `plan`, `status`, `config` (JSON) |
| **UserTenant** | User-to-tenant mapping with roles | `userId`, `tenantId`, `role`, `isDefault` |
| **Role** | RBAC roles per tenant | `name`, `tenantId`, `description` |
| **Permission** | Granular resource-action permissions | `resource`, `action` |
| **RolePermission** | Role-to-permission mapping | `roleId`, `permissionId` |
| **ApiDefinition** | API definitions synced to Tyk | `name`, `slug`, `tykApiId`, `proxyUrl`, `listenPath`, `authType`, `status`, `syncStatus`, `healthStatus` |
| **ApiKey** | API keys with Tyk references | `name`, `tykKeyId`, `keyHash`, `status`, `expiresAt`, `apiDefId` |
| **Quota** | Per-key usage limits | `apiKeyId`, `limit`, `used`, `period`, `resetAt` |
| **AuditLog** | Immutable append-only audit trail | `tenantId`, `userId`, `action`, `resource`, `details` (JSON), `ipAddress`, `corrId` |

**Enums:** `UserStatus`, `TenantStatus`, `TenantPlan`, `ApiStatus`, `ApiSyncStatus`, `ApiHealthStatus`, `ApiAuthType`, `ApiKeyStatus`, `QuotaPeriod`, `AuditAction`

---

## Docker Deployment

### Start All Services

```bash
# Start infrastructure + application services
docker compose -f infra/docker-compose.yml up --build

# Start infrastructure only (PostgreSQL + Redis)
pnpm infra:up
```

### Production Build

```bash
# Build Docker images
docker build -f apps/api/Dockerfile -t open-gateway-api:latest .
docker build -f apps/web/Dockerfile -t open-gateway-web:latest .
```

See [Deployment Guide](docs/deployment.md) for production Docker Compose and CI/CD configuration.

---

## Testing

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# With coverage (add --coverage flag)
pnpm test -- --coverage
```

**Test file naming conventions:**
- Unit tests: `*.service.spec.ts`, `*.controller.spec.ts`
- Integration tests: `*.integration.spec.ts`
- E2E tests: `apps/web/e2e/*.spec.ts`

---

## Contributing

1. **Fork** the repository
2. **Create** your feature branch (`git checkout -b feature/your-feature`)
3. **Develop** following the [Development Guide](docs/development.md)
4. **Validate** your changes: `pnpm lint && pnpm typecheck && pnpm test`
5. **Commit** using [conventional commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `chore:`, `docs:`, etc.)
6. **Push** to your branch
7. **Open** a Pull Request with a clear description

### PR Requirements

- All CI checks pass (lint, typecheck, test, build)
- At least one code review approval
- Description includes: what changed, why, and how to test
- Database migrations included if schema changed
- No secrets or credentials in code or commits

---

## Security

Open Gateway implements **5-layer defense-in-depth**:

1. **Network Isolation** — Private subnets, Tyk gateway REST API (`/tyk`) only reachable from NestJS pods
2. **AuthN/AuthZ** — Ory Hydra (OAuth2/OIDC, 1h access / 720h refresh) + Ory Kratos (login/registration/recovery) + Ory Keto (tenant membership), httpOnly cookies, RBAC + ABAC
3. **Data Protection** — TLS everywhere, Argon2id password hashing (Ory Kratos), PostgreSQL RLS, field-level encryption
4. **Application Security** — Zod validation, Helmet, CSP, rate limiting, circuit breakers
5. **Supply Chain Security** — Dependabot, npm audit, container scanning

**Critical:** Tyk credentials are **never** exposed to the frontend. All Tyk calls go through `TykClientService` in NestJS, which sanitizes responses before returning.

See [Security Documentation](docs/security.md) for details.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/architecture.md) | System design, module dependencies, ADRs |
| [Development Guide](docs/development.md) | Local setup, adding modules, workflows |
| [Deployment Guide](docs/deployment.md) | Docker Compose, CI/CD, backups |
| [Security](docs/security.md) | Security architecture, credential isolation |
| [API README](apps/api/README.md) | Backend-specific documentation |
| [Web README](apps/web/README.md) | Frontend-specific documentation |

---

## License

[MIT License](LICENSE) — Open Gateway is free and open source.

---

## Support

- **Issues:** Open a [GitHub Issue](https://github.com/open-gateway/open-gateway/issues)
- **Discussions:** Use [GitHub Discussions](https://github.com/open-gateway/open-gateway/discussions)
- **Documentation:** Check the [docs/](docs/) directory for detailed guides
