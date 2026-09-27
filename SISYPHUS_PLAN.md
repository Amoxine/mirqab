# SISYPHUS MASTER PLAN — MIRQAB (historical)

> **Historical planning document, not maintained.** This is the original April-2026 generation
> plan, kept for archaeology only. It describes infrastructure (Kubernetes/Helm manifests, a
> Grafana/observability stack, backup automation) that was scaffolded from this doc but never
> built — those empty directories were deleted in WP12b rather than filled, per the owner's
> Compose-only decision (O1). For the current architecture and roadmap see
> [docs/architecture.md](docs/architecture.md) and `.omc/plans/`.

> Production-Grade SaaS Admin Dashboard for Tyk OSS
> Generated: 2026-04-07
> Version: 1.0.0

---

## TABLE OF CONTENTS

1. [Executive Architecture Summary](#section-1--executive-architecture-summary)
2. [Sisyphus Master Plan](#section-2--sisyphus-master-plan)
3. [Agent Execution Matrix](#section-3--agent-execution-matrix)
4. [Monorepo Template](#section-4--monorepo-template)
5. [Domain Blueprint](#section-5--domain-blueprint)
6. [Database Blueprint](#section-6--database-blueprint)
7. [UI Blueprint](#section-7--ui-blueprint)
8. [Delivery Roadmap](#section-8--delivery-roadmap)
9. [OpenCode Handoff Package](#section-9--opencode-handoff-package)

---

## SECTION 1 — EXECUTIVE ARCHITECTURE SUMMARY

### 1.1 High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                            EXTERNAL WORLD                               │
│                                                                         │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────────────────┐   │
│  │   Browser    │    │  Tyk Gateway │    │   Tyk Dashboard/Admin   │   │
│  │  (Admin UI)  │    │  (Traffic)   │    │   (API Management)      │   │
│  └──────┬───────┘    └──────┬───────┘    └──────────┬──────────────┘   │
│         │                   │                       │                   │
│         │ HTTPS             │ API Traffic           │ Admin API         │
│         │                   │                       │ (REST)            │
│         ▼                   ▼                       ▼                   │
├─────────┼───────────────────┼───────────────────────┼───────────────────┤
│         │                   │                       │                   │
│  ┌──────▼───────┐           │               ┌───────▼──────────────┐    │
│  │  Next.js 15  │           │               │     NestJS 11        │    │
│  │  (Web App)   │───────────┼──────────────►│     (API Server)     │    │
│  │              │  REST/    │  ONLY NestJS  │                      │    │
│  │ - SSR pages  │  JSON     │  calls Tyk    │ - Auth (JWT/OIDC)    │    │
│  │ - Dashboard  │           │               │ - API CRUD           │    │
│  │ - Tables     │           │               │ - Key management     │    │
│  │ - Forms      │           │               │ - Tyk proxy          │    │
│  │ - Analytics  │           │               │ - Audit logging      │    │
│  └──────┬───────┘           │               └───────┬──────────────┘    │
│         │                   │                       │                   │
│         │                   │               ┌───────▼──────────────┐    │
│         │                   │               │     PostgreSQL 16    │    │
│         │                   │               │     + Prisma 6       │    │
│         │                   │               │                      │    │
│         │                   │               │ - Users, Roles       │    │
│         │                   │               │ - Tenants            │    │
│         │                   │               │ - API definitions    │    │
│         │                   │               │ - Audit logs         │    │
│         │                   │               └──────────────────────┘    │
│         │                   │                                           │
│         │                   │               ┌──────────────────────┐    │
│         │                   │               │      Redis 7         │    │
│         │                   │               │                      │    │
│         │                   │               │ - Cache              │    │
│         │                   │               │ - Rate limiting      │    │
│         │                   │               │ - Sessions           │    │
│         │                   │               │ - Pub/Sub (events)   │    │
│         │                   │               └──────────────────────┘    │
│         │                   │                                           │
├─────────┼───────────────────┼───────────────────────────────────────────┤
│         │                   │              OBSERVABILITY                │
│         │                   │   ┌───────────────────────────────────┐   │
│         │                   │   │     OpenTelemetry Collector       │   │
│         │                   │   │     Prometheus + Grafana          │   │
│         │                   │   │     Loki (logs)                   │   │
│         │                   │   │     Tempo (traces)                │   │
│         │                   │   └───────────────────────────────────┘   │
└─────────┴───────────────────┴───────────────────────────────────────────┘
```

### 1.2 Deployment Model

| Layer | Configuration |
|-------|-------------|
| **Container Runtime** | Docker (dev), Containerd (prod/K8s) |
| **Orchestration** | Kubernetes 1.29+ (Helm charts) |
| **Service Mesh** | Optional: Istio for mTLS, traffic splitting |
| **Load Balancing** | Ingress NGINX → ClusterIP Services → Pods |
| **Database** | PostgreSQL with Patroni for HA, PgBouncer pooling |
| **Cache** | Redis Sentinel (3-node) or Redis Cluster |
| **Secrets** | Kubernetes Sealed Secrets or HashiCorp Vault |
| **TLS** | cert-manager with Let's Encrypt (staging/prod) |
| **CI/CD** | GitHub Actions: lint → test → build → push → deploy |

### 1.3 Scalability Assumptions

| Component | Min Replicas | Max Replicas | Scale Trigger | Cool-down |
|-----------|-------------|-------------|---------------|-----------|
| Next.js SSR | 2 | 10 | CPU > 70% | 120s |
| Next.js API Routes | 2 | 10 | CPU > 70% | 120s |
| NestJS API | 3 | 15 | CPU > 60% / Mem > 75% | 90s |
| PgBouncer | 2 | 4 | Connections > 80% | 120s |
| Redis | 3 | 6 | Memory > 70% | Manual |
| OTEL Collector | 2 | 6 | CPU > 65% | 120s |

**Stateless by design:** All application pods are stateless. Session state is in JWT (httpOnly cookies) + Redis. No sticky sessions required.

### 1.4 Security Principles

**Defense in Depth — 5 Layers:**

1. **Network Isolation** — Private subnets, no public pod IPs, deny-all network policies, mTLS via service mesh, Tyk Admin only reachable from NestJS pods.
2. **AuthN/AuthZ** — OIDC (Keycloak/Okta/Auth0), JWT (15min access, 7d refresh), httpOnly + secure + SameSite=Strict cookies, RBAC (super_admin, admin, operator, viewer), ABAC for tenant ownership.
3. **Data Protection** — TLS 1.3 everywhere, AES-256 at rest, field-level encryption for secrets (Vault Transit), PostgreSQL Row-Level Security, Prisma parameterized queries only, immutable audit log.
4. **Application Security** — Zod validation on all inputs, React auto-escaping, CSP headers, Helmet on NestJS, CORS whitelist, no dangerouslySetInnerHTML without sanitization.
5. **Supply Chain Security** — Renovate/Dependabot, npm audit (block on critical), Trivy container scanning, Syft SBOM, cosign signed images.

**CRITICAL: Tyk Credential Isolation**
- Tyk Admin API key stored in Vault/K8s Secrets
- Injected into NestJS pod as env var at startup only
- **NEVER** passed to Next.js frontend
- **NEVER** logged or included in error messages
- NestJS TykClientService wraps ALL Tyk calls — raw responses sanitized

### 1.5 Bounded Contexts

| Bounded Context | NestJS Module | Owns | Exposes |
|----------------|---------------|------|---------|
| Identity & Access | AuthModule | Users, Roles, Sessions, JWT, Permissions | `/auth/*`, `GET /users`, `GET /roles`, `GET /permissions` |
| Tenancy | TenantModule | Tenants, Tenant Config, User-Tenant mapping | `/tenants/*` |
| API Lifecycle | ApiManagementModule | API definitions, Tyk sync, Health checks | `/apis/*` |
| Key & Policy | KeysModule + QuotasModule | API keys, Tyk policies, Quotas, Rate limits | `/keys/*`, `/quotas/*` |
| Analytics | AnalyticsModule | Usage stats, Aggregations, Dashboards | `/analytics/*` |
| Audit | AuditModule | Audit log, Event stream, Compliance | `/audit-logs/*` |

**Inter-context communication:** Within NestJS (single process), contexts communicate via direct service injection. Each module uses port/adapter interfaces (hexagonal architecture) to enable future microservices extraction.

---

## SECTION 2 — SISYPHUS MASTER PLAN

### EPIC 1 — FOUNDATION

#### MILESTONE 1.1 — Monorepo Bootstrap

**TASK 1.1.1 — Initialize pnpm Workspace**
- **Description:** Create root package.json, pnpm-workspace.yaml, configure workspace protocols
- **Dependencies:** None
- **Risks:** Node version mismatch, pnpm version conflicts
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** `pnpm install` succeeds from root, workspace protocol resolves all packages
- **Done Checklist:**
  - [ ] package.json with workspace scripts
  - [ ] pnpm-workspace.yaml with apps/* and packages/* patterns
  - [ ] .npmrc with shamefully-hoist=false
  - [ ] packageManager field set
- **Output Artifacts:** `/package.json`, `/pnpm-workspace.yaml`, `/.npmrc`

**TASK 1.1.2 — Turborepo Configuration**
- **Description:** Configure turbo.json with pipeline, caching, task dependencies
- **Dependencies:** 1.1.1
- **Risks:** Incorrect task dependency graph causes build failures
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** `turbo run build` executes correct task order, cache hits on repeated runs
- **Done Checklist:**
  - [ ] turbo.json with globalDependencies, globalEnv
  - [ ] Task pipeline for dev, build, lint, typecheck, test
  - [ ] Correct dependsOn for build (needs ^build)
  - [ ] Remote caching configured (optional)
- **Output Artifacts:** `/turbo.json`

**TASK 1.1.3 — TypeScript Base Configuration**
- **Description:** Create shared tsconfig files for root, node, and browser targets
- **Dependencies:** 1.1.1
- **Risks:** Incompatible compiler options between Next.js and NestJS
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** FRONTEND_ARCHITECT_AGENT
- **Acceptance Criteria:** TypeScript compiles with strict mode, no implicit any, strictNullChecks
- **Done Checklist:**
  - [ ] tsconfig.json (base, strict: true)
  - [ ] tsconfig.node.json (for NestJS)
  - [ ] tsconfig.browser.json (for Next.js)
  - [ ] paths configured for workspace packages
- **Output Artifacts:** `/tsconfig.json`, `/tsconfig.node.json`, `/packages/config/tsconfig/base.json`

**TASK 1.1.4 — ESLint Flat Config**
- **Description:** Configure ESLint 9 flat config with TypeScript, React, NestJS rules
- **Dependencies:** 1.1.3
- **Risks:** Plugin version conflicts, parser errors
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** FRONTEND_ARCHITECT_AGENT
- **Acceptance Criteria:** `pnpm lint` runs without errors on all packages, TypeScript type-aware rules active
- **Done Checklist:**
  - [ ] eslint.config.js with flat config
  - [ ] TypeScript ESLint with parserServices
  - [ ] React hooks rules enabled
  - [ ] Security rules (no eval, no imul, etc.)
  - [ ] Per-package overrides via files patterns
- **Output Artifacts:** `/eslint.config.js`, `/packages/config/eslint/base.js`

**TASK 1.1.5 — Prettier Configuration**
- **Description:** Configure Prettier with project-wide formatting rules
- **Dependencies:** 1.1.1
- **Risks:** Conflicts with ESLint formatting rules
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** FRONTEND_ARCHITECT_AGENT
- **Acceptance Criteria:** `pnpm format:check` passes on clean codebase
- **Done Checklist:**
  - [ ] .prettierrc with printWidth, tabWidth, trailingComma
  - [ ] .prettierignore for generated files
  - [ ] eslint-config-prettier to disable conflicting rules
- **Output Artifacts:** `/.prettierrc`, `/.prettierignore`

**TASK 1.1.6 — Editor Configuration**
- **Description:** .editorconfig for consistent formatting across IDEs
- **Dependencies:** 1.1.5
- **Risks:** None (low risk)
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** .editorconfig present with correct settings
- **Done Checklist:**
  - [ ] .editorconfig with indent_size, charset, end_of_line
  - [ ] .gitignore with node_modules, dist, .next, .env.*
  - [ ] .dockerignore matching .gitignore patterns
- **Output Artifacts:** `/.editorconfig`, `/.gitignore`, `/.dockerignore`

#### MILESTONE 1.2 — Docker & Local Dev Environment

**TASK 1.2.1 — Docker Compose Setup**
- **Description:** Create docker-compose.yml with PostgreSQL, Redis, health checks, networking
- **Dependencies:** 1.1.1
- **Risks:** Port conflicts with local services, volume permission issues
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** `docker compose up` starts healthy PostgreSQL and Redis services
- **Done Checklist:**
  - [ ] postgres:16-alpine service with health check
  - [ ] redis:7-alpine service with health check
  - [ ] Named volumes for data persistence
  - [ ] Custom bridge network
  - [ ] .env file for credentials
- **Output Artifacts:** `/infra/docker-compose.yml`

**TASK 1.2.2 — Next.js Dockerfile**
- **Description:** Multi-stage production Dockerfile for Next.js standalone output
- **Dependencies:** 1.1.1
- **Risks:** Large image size, missing dependencies in production stage
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** FRONTEND_ARCHITECT_AGENT
- **Acceptance Criteria:** Image builds and runs, serves pages on port 3000, non-root user
- **Done Checklist:**
  - [ ] Multi-stage build (deps, builder, runner)
  - [ ] output: 'standalone' in next.config
  - [ ] Non-root user in runner stage
  - [ ] HEALTHCHECK instruction
  - [ ] .dockerignore for node_modules, .next
- **Output Artifacts:** `/apps/web/Dockerfile`

**TASK 1.2.3 — NestJS Dockerfile**
- **Description:** Multi-stage production Dockerfile for NestJS
- **Dependencies:** 1.1.1
- **Risks:** Missing native modules, build dependencies in runner
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** Image builds and runs, serves API on port 4000, non-root user
- **Done Checklist:**
  - [ ] Multi-stage build (deps, builder, runner)
  - [ ] npm install --omit=dev for production
  - [ ] Non-root user in runner stage
  - [ ] HEALTHCHECK instruction
  - [ ] Node.js production flags
- **Output Artifacts:** `/apps/api/Dockerfile`

**TASK 1.2.4 — Environment Templates**
- **Description:** Create .env.example files for all services with documented variables
- **Dependencies:** 1.2.1
- **Risks:** Missing critical variables, undocumented variables cause runtime errors
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** All required env vars documented, application starts with .env.example values
- **Done Checklist:**
  - [ ] apps/web/.env.example with all NEXT_PUBLIC_* vars
  - [ ] apps/api/.env.example with DATABASE_URL, REDIS_URL, JWT_SECRET, TYK_* vars
  - [ ] Each variable has description comment
  - [ ] No secrets committed to repo
- **Output Artifacts:** `/apps/web/.env.example`, `/apps/api/.env.example`

**TASK 1.2.5 — Dev Bootstrap Script**
- **Description:** Create setup.sh for first-time contributor onboarding
- **Dependencies:** 1.2.1, 1.2.4
- **Risks:** Script fails on different OS environments
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** `bash infra/scripts/setup.sh` provisions local environment from scratch
- **Done Checklist:**
  - [ ] Installs pnpm if missing
  - [ ] Runs pnpm install
  - [ ] Copies .env.example to .env.local
  - [ ] Starts docker compose
  - [ ] Runs db:migrate:dev and db:seed
  - [ ] Prints success message with URLs
- **Output Artifacts:** `/infra/scripts/setup.sh`

#### MILESTONE 1.3 — CI/CD Pipeline

**TASK 1.3.1 — CI Workflow**
- **Description:** GitHub Actions workflow for lint, typecheck, test, build on PR
- **Dependencies:** 1.1.1
- **Risks:** Flaky tests causing CI failures, slow builds
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** CI runs on every push/PR, all checks pass on clean main
- **Done Checklist:**
  - [ ] .github/workflows/ci.yml
  - [ ] pnpm cache enabled
  - [ ] Turbo affected projects detection
  - [ ] Type check step
  - [ ] Lint step
  - [ ] Test step with coverage
  - [ ] Build step
- **Output Artifacts:** `/.github/workflows/ci.yml`

**TASK 1.3.2 — CD Staging Workflow**
- **Description:** GitHub Actions workflow for staging deployment on merge to main
- **Dependencies:** 1.3.1
- **Risks:** Broken deploy to staging blocks all development
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** Merge to main triggers staging deploy, health check passes
- **Done Checklist:**
  - [ ] .github/workflows/cd-staging.yml
  - [ ] Docker image build and push
  - [ ] Helm upgrade or kubectl apply
  - [ ] Health check after deploy
- **Output Artifacts:** `/.github/workflows/cd-staging.yml`

**TASK 1.3.3 — Dependabot Configuration**
- **Description:** Automated dependency update configuration
- **Dependencies:** 1.1.1
- **Risks:** Breaking updates without proper testing
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** Dependabot opens PRs for outdated dependencies weekly
- **Done Checklist:**
  - [ ] .github/dependabot.yml with npm, docker, github-actions ecosystems
  - [ ] Weekly schedule
  - [ ] Labels and reviewers configured
- **Output Artifacts:** `/.github/dependabot.yml`

---

### EPIC 2 — CORE INFRASTRUCTURE

#### MILESTONE 2.1 — Database Schema & Prisma Setup

**TASK 2.1.1 — Prisma Package Initialization**
- **Description:** Create @open-gateway/database package with Prisma client
- **Dependencies:** 1.1.1
- **Risks:** Prisma version mismatch with PostgreSQL
- **Owner Agent:** DATA_ARCHITECT_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** `pnpm db:generate` creates Prisma client, imports work from other packages
- **Done Checklist:**
  - [ ] packages/database/package.json
  - [ ] packages/database/tsconfig.json
  - [ ] Prisma schema with datasource and generator
  - [ ] Re-exported PrismaClient from src/index.ts
- **Output Artifacts:** `/packages/database/package.json`, `/packages/database/prisma/schema.prisma`, `/packages/database/src/index.ts`

**TASK 2.1.2 — Core Schema Models**
- **Description:** Define User, Tenant, Role, Permission, ApiDefinition, ApiKey, AuditLog models
- **Dependencies:** 2.1.1
- **Risks:** Incorrect relations cause N+1 queries, missing indexes cause slow queries
- **Owner Agent:** DATA_ARCHITECT_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** Schema validates, migration generates without errors, all relations correct
- **Done Checklist:**
  - [ ] User model with auth fields
  - [ ] Tenant model with isolation fields
  - [ ] UserTenant junction table
  - [ ] Role and Permission models
  - [ ] RolePermission junction table
  - [ ] ApiDefinition model with Tyk reference
  - [ ] ApiKey model with Tyk reference
  - [ ] AuditLog model (append-only)
  - [ ] All @@index, @@unique constraints
  - [ ] Enum types for status fields
- **Output Artifacts:** `/packages/database/prisma/schema.prisma`

**TASK 2.1.3 — Database Migrations**
- **Description:** Generate and apply initial migration, create seed data
- **Dependencies:** 2.1.2
- **Risks:** Migration conflicts in team, seed data conflicts
- **Owner Agent:** DATA_ARCHITECT_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** `pnpm db:migrate:dev` applies cleanly, seed populates default data
- **Done Checklist:**
  - [ ] Initial migration generated
  - [ ] Seed script with default admin user
  - [ ] Seed script with default roles/permissions
  - [ ] Idempotent seed (safe to run multiple times)
- **Output Artifacts:** `/packages/database/prisma/migrations/`, `/packages/database/prisma/seed.ts`

**TASK 2.1.4 — Database Indexing Strategy**
- **Description:** Add composite indexes for common query patterns
- **Dependencies:** 2.1.2
- **Risks:** Missing indexes cause full table scans, too many indexes slow writes
- **Owner Agent:** DATA_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** EXPLAIN ANALYZE shows index usage for common queries
- **Done Checklist:**
  - [ ] Index on (tenant_id, status) for filtered tenant queries
  - [ ] Index on (user_id, tenant_id) for user-tenant lookups
  - [ ] Composite index on audit_log (tenant_id, created_at DESC)
  - [ ] Index on api_key (tenant_id, status)
  - [ ] Partial index on soft-deleted records
  - [ ] Full-text index on name fields where applicable
- **Output Artifacts:** Updated `/packages/database/prisma/schema.prisma`

#### MILESTONE 2.2 — Redis Integration

**TASK 2.2.1 — Redis Client Setup**
- **Description:** Configure Redis client with connection pooling, retry logic
- **Dependencies:** 1.2.1
- **Risks:** Connection exhaustion, unhandled reconnection errors
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** Redis connects, reconnects on failure, health check passes
- **Done Checklist:**
  - [ ] Redis client with ioredis
  - [ ] Connection retry strategy
  - [ ] Health check endpoint
  - [ ] Graceful shutdown
- **Output Artifacts:** `/apps/api/src/common/redis/redis.module.ts`, `/apps/api/src/common/redis/redis.service.ts`

**TASK 2.2.2 — Cache Module**
- **Description:** Implement caching interceptor with TTL, cache invalidation
- **Dependencies:** 2.2.1
- **Risks:** Stale cache data, cache stampede under load
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** GET responses cached with configurable TTL, cache invalidates on mutations
- **Done Checklist:**
  - [ ] @Cacheable() decorator
  - [ ] Cache invalidation on POST/PUT/DELETE
  - [ ] TTL configuration per endpoint
  - [ ] Cache key prefixing by tenant
- **Output Artifacts:** `/apps/api/src/common/cache/cache.interceptor.ts`, `/apps/api/src/common/cache/cache.decorator.ts`

#### MILESTONE 2.3 — OpenTelemetry Setup

**TASK 2.3.1 — OTEL SDK Integration (NestJS)**
- **Description:** Configure OpenTelemetry SDK in NestJS with tracing, metrics, logs
- **Dependencies:** 1.2.1
- **Risks:** Performance overhead from tracing, incorrect propagation
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** Traces exported to collector, metrics visible in Prometheus
- **Done Checklist:**
  - [ ] OTEL SDK bootstrap in main.ts
  - [ ] HTTP instrumentation
  - [ ] Prisma instrumentation
  - [ ] Redis instrumentation
  - [ ] Custom spans for Tyk calls
  - [ ] OTLP exporter configured
- **Output Artifacts:** `/apps/api/src/common/telemetry/otel.module.ts`

**TASK 2.3.2 — OTEL SDK Integration (Next.js)**
- **Description:** Configure OpenTelemetry SDK in Next.js for frontend tracing
- **Dependencies:** 2.3.1
- **Risks:** Browser OTEL not available, SSR trace propagation
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** FRONTEND_ARCHITECT_AGENT
- **Acceptance Criteria:** Server-side traces from Next.js propagate to NestJS traces
- **Done Checklist:**
  - [ ] @opentelemetry/sdk-node in Next.js
  - [ ] Trace context propagation in API calls
  - [ ] Custom spans for page renders
- **Output Artifacts:** `/apps/web/src/lib/telemetry.ts`

---

### EPIC 3 — AUTHENTICATION & AUTHORIZATION

#### MILESTONE 3.1 — JWT Auth Flow

**TASK 3.1.1 — JWT Strategy Implementation**
- **Description:** Implement JWT authentication with access/refresh tokens in NestJS
- **Dependencies:** 2.1.3
- **Risks:** Token theft, replay attacks, clock skew
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** Valid JWT accepted, expired JWT rejected, invalid signature rejected
- **Done Checklist:**
  - [ ] JwtStrategy with passport-jwt
  - [ ] Access token generation (15min TTL)
  - [ ] Refresh token generation (7d TTL)
  - [ ] Token stored in httpOnly secure cookie
  - [ ] JWT contains: sub, email, roles[], tenant_id
- **Output Artifacts:** `/apps/api/src/modules/auth/strategies/jwt.strategy.ts`, `/apps/api/src/modules/auth/services/auth.service.ts`

**TASK 3.1.2 — Auth Controller & Endpoints**
- **Description:** Implement /auth/login, /auth/register, /auth/refresh, /auth/logout endpoints
- **Dependencies:** 3.1.1
- **Risks:** Credential stuffing, brute force
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** Login returns JWT cookie, refresh rotates refresh token, logout invalidates token
- **Done Checklist:**
  - [ ] POST /auth/login with email/password
  - [ ] POST /auth/register with validation
  - [ ] POST /auth/refresh with refresh token
  - [ ] POST /auth/logout with cookie clear
  - [ ] GET /auth/me returns current user
  - [ ] Rate limiting on /auth/login (5/min)
  - [ ] Password hashing with bcrypt (cost 12)
- **Output Artifacts:** `/apps/api/src/modules/auth/controllers/auth.controller.ts`, `/apps/api/src/modules/auth/dto/login.dto.ts`

**TASK 3.1.3 — Auth Guards**
- **Description:** Implement JWT guard, RBAC guard, tenant isolation guard
- **Dependencies:** 3.1.1, 2.1.2
- **Risks:** Guard bypass, incorrect tenant scoping
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** Protected routes reject unauthenticated requests, RBAC denies unauthorized actions
- **Done Checklist:**
  - [ ] JwtAuthGuard extracts and validates JWT
  - [ ] RolesGuard checks @Roles() decorator
  - [ ] TenantIsolationGuard ensures user has access to tenant
  - [ ] @CurrentUser() and @CurrentTenant() decorators
  - [ ] Unit tests for all guards
- **Output Artifacts:** `/apps/api/src/common/guards/jwt-auth.guard.ts`, `/apps/api/src/common/guards/roles.guard.ts`, `/apps/api/src/common/guards/tenant-isolation.guard.ts`

**TASK 3.1.4 — Frontend Auth Integration**
- **Description:** Implement login page, auth context, API client with auth interceptors
- **Dependencies:** 3.1.2
- **Risks:** Token leakage in browser, CSRF attacks
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** Login form submits to /auth/login, authenticated API calls include cookies, unauthenticated redirects to /login
- **Done Checklist:**
  - [ ] Login page with React Hook Form + zod
  - [ ] Auth redirect logic in (dashboard) layout
  - [ ] API client with error interceptor (401 → redirect)
  - [ ] CSRF token handling for mutations
  - [ ] Loading state during auth check
- **Output Artifacts:** `/apps/web/src/app/(auth)/login/page.tsx`, `/apps/web/src/lib/api-client.ts`

#### MILESTONE 3.2 — RBAC System

**TASK 3.2.1 — Role & Permission Models**
- **Description:** Implement Role, Permission, and RolePermission models with seed data
- **Dependencies:** 2.1.3
- **Risks:** Permission escalation, orphan permissions
- **Owner Agent:** DATA_ARCHITECT_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** Seed creates 4 roles (super_admin, admin, operator, viewer) with correct permissions
- **Done Checklist:**
  - [ ] Role model with name, description, tenant_id
  - [ ] Permission model with resource, action fields
  - [ ] RolePermission junction table
  - [ ] Seed data for default roles
  - [ ] Permission matrix: resource × action
- **Output Artifacts:** Updated schema.prisma, updated seed.ts

**TASK 3.2.2 — Permission Service & Guard**
- **Description:** Implement permission checking service and @Permissions() decorator
- **Dependencies:** 3.2.1, 3.1.3
- **Risks:** Permission check bypass, stale permission cache
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** @Permissions('api:create') denies users without that permission
- **Done Checklist:**
  - [ ] PermissionService.hasPermission(userId, resource, action)
  - [ ] @Permissions() decorator
  - [ ] PermissionsGuard
  - [ ] Permission check cached in Redis (5min TTL)
- **Output Artifacts:** `/apps/api/src/modules/permissions/services/permission.service.ts`, `/apps/api/src/common/guards/permissions.guard.ts`

---

### EPIC 4 — TENANT MANAGEMENT

#### MILESTONE 4.1 — Tenant CRUD

**TASK 4.1.1 — Tenant Service & Controller**
- **Description:** Implement full CRUD for tenants with validation
- **Dependencies:** 2.1.3, 3.1.3
- **Risks:** Tenant data leakage, duplicate slugs
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** DATA_ARCHITECT_AGENT
- **Acceptance Criteria:** Create/read/update/delete tenants, slug unique constraint enforced
- **Done Checklist:**
  - [ ] POST /tenants with validation
  - [ ] GET /tenants with pagination
  - [ ] GET /tenants/:id
  - [ ] PATCH /tenants/:id
  - [ ] DELETE /tenants/:id (soft delete)
  - [ ] Slug unique constraint
  - [ ] Tenant status enum (active, suspended, archived)
- **Output Artifacts:** `/apps/api/src/modules/tenants/controllers/tenant.controller.ts`, `/apps/api/src/modules/tenants/services/tenant.service.ts`

**TASK 4.1.2 — Tenant Isolation Enforcement**
- **Description:** Ensure all queries scoped to tenant_id, RLS policies on PostgreSQL
- **Dependencies:** 4.1.1, 2.1.4
- **Risks:** **CRITICAL** — data leakage between tenants
- **Owner Agent:** DATA_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** User of tenant A cannot see data of tenant B, verified by integration tests
- **Done Checklist:**
  - [ ] TenantIsolationGuard on all data routes
  - [ ] tenant_id injected into query context
  - [ ] Prisma middleware adds tenant filter
  - [ ] PostgreSQL RLS policies for critical tables
  - [ ] Integration tests for cross-tenant access attempts
- **Output Artifacts:** Prisma middleware, RLS migration file

**TASK 4.1.3 — Tenant Onboarding Flow**
- **Description:** Implement multi-step tenant creation with default admin assignment
- **Dependencies:** 4.1.1, 3.1.2
- **Risks:** Partial onboarding (tenant created but no admin assigned)
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** Onboarding creates tenant, assigns admin role, redirects to dashboard
- **Done Checklist:**
  - [ ] Tenant creation transactional (tenant + user-tenant mapping)
  - [ ] Default admin role assigned to creator
  - [ ] Welcome email (placeholder for SMTP)
  - [ ] Frontend onboarding wizard
- **Output Artifacts:** `/apps/api/src/modules/tenants/services/onboarding.service.ts`

#### MILESTONE 4.2 — Multi-Tenant Context

**TASK 4.2.1 — Tenant Switching**
- **Description:** Users can switch between tenants they belong to
- **Dependencies:** 4.1.1
- **Risks:** Stale tenant context, cached data from wrong tenant
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** User switches tenant, all data reloads for new tenant
- **Done Checklist:**
  - [ ] Tenant selector in dashboard header
  - [ ] Current tenant stored in session/cookie
  - [ ] TanStack Query cache invalidated on switch
  - [ ] API calls include current tenant header
- **Output Artifacts:** `/apps/web/src/components/layout/tenant-switcher.tsx`

---

### EPIC 5 — API MANAGEMENT

#### MILESTONE 5.1 — API CRUD Operations

**TASK 5.1.1 — API Definition Model & Service**
- **Description:** Implement ApiDefinition CRUD with validation
- **Dependencies:** 2.1.3, 4.1.1
- **Risks:** Invalid proxy URLs, listen path conflicts
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** DATA_ARCHITECT_AGENT
- **Acceptance Criteria:** API definition created, validated, stored with tenant scoping
- **Done Checklist:**
  - [ ] ApiDefinition Prisma model
  - [ ] Create API with URL validation
  - [ ] List APIs with pagination and filters
  - [ ] Update API definition
  - [ ] Delete API (soft delete)
  - [ ] API status enum (draft, active, disabled)
- **Output Artifacts:** `/apps/api/src/modules/api-management/models/api-definition.entity.ts`

**TASK 5.1.2 — API Frontend Pages**
- **Description:** Implement API list, detail, create, edit pages
- **Dependencies:** 5.1.1
- **Risks:** Form validation gaps, poor UX on error
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** Full CRUD UI with validation, error handling, loading states
- **Done Checklist:**
  - [ ] /apis page with TanStack Table
  - [ ] /apis/new page with multi-step form
  - [ ] /apis/[id] page with details
  - [ ] /apis/[id]/edit page
  - [ ] Server-side pagination, sorting, filtering
  - [ ] Bulk actions (enable/disable/delete)
- **Output Artifacts:** `/apps/web/src/app/(dashboard)/apis/page.tsx`, `/apps/web/src/app/(dashboard)/apis/new/page.tsx`

#### MILESTONE 5.2 — Tyk Integration Service

**TASK 5.2.1 — Tyk Client Service**
- **Description:** Implement HTTP client for Tyk Admin API with auth, error handling
- **Dependencies:** 3.1.1, 2.2.1
- **Risks:** **CRITICAL** — Tyk credentials exposed, Tyk API changes
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** Tyk client authenticates, makes calls, handles errors, NEVER exposes credentials
- **Done Checklist:**
  - [ ] TykClientService with fetch/axios
  - [ ] Admin key from env var (never logged)
  - [ ] Type-safe request/response DTOs
  - [ ] Error mapping (Tyk errors → domain errors)
  - [ ] Response sanitization (strip internal IDs)
  - [ ] Unit tests with mocked Tyk responses
- **Output Artifacts:** `/apps/api/src/modules/tyk-integration/services/tyk-client.service.ts`

**TASK 5.2.2 — API Sync Pipeline**
- **Description:** Sync API definitions to Tyk, handle failures, retry with backoff
- **Dependencies:** 5.2.1, 5.1.1
- **Risks:** Tyk unavailable, sync failures leave inconsistent state
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** API created in DB → synced to Tyk → status updated → audit log entry
- **Done Checklist:**
  - [ ] On API create → call TykClientService.createApi()
  - [ ] Store Tyk API ID in our database
  - [ ] On API update → call TykClientService.updateApi()
  - [ ] On API delete → call TykClientService.deleteApi()
  - [ ] Retry with exponential backoff (3 attempts)
  - [ ] Circuit breaker for Tyk (5 failures → open)
  - [ ] Sync status tracked (pending, synced, failed)
  - [ ] Audit log entry for each sync operation
- **Output Artifacts:** `/apps/api/src/modules/tyk-integration/services/api-sync.service.ts`

**TASK 5.2.3 — Circuit Breaker for Tyk**
- **Description:** Implement circuit breaker pattern for Tyk Admin API calls
- **Dependencies:** 5.2.1
- **Risks:** Cascading failures, false positives triggering circuit
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** After 5 consecutive Tyk failures, circuit opens, operations queued
- **Done Checklist:**
  - [ ] CircuitBreaker service with configurable thresholds
  - [ ] Half-open state with test requests
  - [ ] Queue for operations during open circuit
  - [ ] Background worker retries when circuit closes
  - [ ] Health endpoint shows Tyk circuit status
  - [ ] Frontend shows "Tyk sync pending" indicator
- **Output Artifacts:** `/apps/api/src/common/circuit-breaker/circuit-breaker.service.ts`

#### MILESTONE 5.3 — API Health Monitoring

**TASK 5.3.1 — API Health Check Service**
- **Description:** Periodically check API health via Tyk analytics/uptime
- **Dependencies:** 5.2.1
- **Risks:** Health check adds load to Tyk, false health reports
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** Health status updated every 60s, visible in dashboard
- **Done Checklist:**
  - [ ] Cron job or scheduler (every 60s)
  - [ ] Check Tyk API status
  - [ ] Update API health status in DB
  - [ ] Expose health via GET /apis/:id/health
  - [ ] Frontend health indicator on API cards
- **Output Artifacts:** `/apps/api/src/modules/api-management/services/api-health.service.ts`

---

### EPIC 6 — API KEY MANAGEMENT

#### MILESTONE 6.1 — Key Generation & Lifecycle

**TASK 6.1.1 — API Key Service**
- **Description:** Implement API key CRUD with Tyk key provisioning
- **Dependencies:** 5.2.1, 4.1.1
- **Risks:** Key generation conflicts, orphan keys in Tyk
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** Key created in DB → provisioned in Tyk → key hash returned (never full key)
- **Done Checklist:**
  - [ ] ApiKey model with tenant_id, user_id
  - [ ] Generate key via Tyk API
  - [ ] Store key metadata (not the actual key value)
  - [ ] List keys with pagination
  - [ ] Revoke key (Tyk + DB status update)
  - [ ] Key expiration support
- **Output Artifacts:** `/apps/api/src/modules/keys/services/api-key.service.ts`

**TASK 6.1.2 — Key Frontend Pages**
- **Description:** Implement key list, create, detail, revoke UI
- **Dependencies:** 6.1.1
- **Risks:** Key value shown in plain text in logs/UI
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** Key value shown once on creation, masked afterwards, revoke confirmed via dialog
- **Done Checklist:**
  - [ ] /keys page with TanStack Table
  - [ ] /keys/new page with quota/rate limit form
  - [ ] Key value displayed once in secure dialog
  - [ ] Copy to clipboard button
  - [ ] Revoke confirmation dialog
  - [ ] Key status badges (active, revoked, expired)
- **Output Artifacts:** `/apps/web/src/app/(dashboard)/keys/page.tsx`, `/apps/web/src/app/(dashboard)/keys/new/page.tsx`

#### MILESTONE 6.2 — Quota Management

**TASK 6.2.1 — Quota Service**
- **Description:** Implement quota tracking and enforcement via Tyk policies
- **Dependencies:** 6.1.1
- **Risks:** Quota tracking drift, Tyk policy sync failures
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** DATA_ARCHITECT_AGENT
- **Acceptance Criteria:** Quota limits enforced, usage tracked, reset scheduled
- **Done Checklist:**
  - [ ] Quota model with limit, used, reset_at
  - [ ] Tyk policy creation for quota limits
  - [ ] Usage tracking from Tyk analytics
  - [ ] Quota reset scheduler
  - [ ] Quota exceeded handling
- **Output Artifacts:** `/apps/api/src/modules/quotas/services/quota.service.ts`

**TASK 6.2.2 — Quota Frontend Components**
- **Description:** Implement quota meter, quota settings in key form
- **Dependencies:** 6.2.1
- **Risks:** Incorrect quota display
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** Quota meter shows usage percentage, warns at 80%, critical at 95%
- **Done Checklist:**
  - [ ] QuotaMeter component
  - [ ] Quota settings in key creation form
  - [ ] Color-coded usage indicator
  - [ ] Alert on quota exceeded
- **Output Artifacts:** `/apps/web/src/components/keys/quota-meter.tsx`

---

### EPIC 7 — ANALYTICS & AUDIT

#### MILESTONE 7.1 — Usage Analytics

**TASK 7.1.1 — Analytics Data Pipeline**
- **Description:** Collect and aggregate usage data from Tyk analytics
- **Dependencies:** 5.2.1
- **Risks:** Large data volume, slow aggregation queries
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** DATA_ARCHITECT_AGENT
- **Acceptance Criteria:** Analytics API returns aggregated data within 2s for 30-day range
- **Done Checklist:**
  - [ ] GET /analytics/overview (summary metrics)
  - [ ] GET /analytics/apis (per-API metrics)
  - [ ] GET /analytics/keys (per-key metrics)
  - [ ] Date range filtering
  - [ ] Aggregation caching (5min TTL)
  - [ ] Materialized view for common queries
- **Output Artifacts:** `/apps/api/src/modules/analytics/controllers/analytics.controller.ts`

**TASK 7.1.2 — Analytics Dashboard UI**
- **Description:** Implement analytics page with charts, metrics cards, date range picker
- **Dependencies:** 7.1.1
- **Risks:** Chart rendering performance, large dataset handling
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** Dashboard loads within 3s, charts render smoothly, date range filtering works
- **Done Checklist:**
  - [ ] /analytics page
  - [ ] Metric cards (total requests, avg latency, error rate, active keys)
  - [ ] Time series chart (requests over time)
  - [ ] Top APIs table
  - [ ] Date range picker
  - [ ] Auto-refresh toggle
- **Output Artifacts:** `/apps/web/src/app/(dashboard)/analytics/page.tsx`

#### MILESTONE 7.2 — Audit Logging

**TASK 7.2.1 — Audit Log Interceptor**
- **Description:** Implement audit logging interceptor that captures all mutations
- **Dependencies:** 3.1.3, 2.1.2
- **Risks:** Audit log performance impact, missing mutations
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** Every POST/PUT/DELETE creates immutable audit log entry
- **Done Checklist:**
  - [ ] AuditLogInterceptor on mutation routes
  - [ ] Captures: user_id, tenant_id, action, resource, before/after, IP, timestamp
  - [ ] Async write (non-blocking)
  - [ ] Append-only table constraint
  - [ ] Correlation ID from request
- **Output Artifacts:** `/apps/api/src/modules/audit/interceptors/audit-log.interceptor.ts`

**TASK 7.2.2 — Audit Log Viewer**
- **Description:** Implement audit log list page with search, filters, export
- **Dependencies:** 7.2.1, 2.1.2
- **Risks:** Slow queries on large audit log tables
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** DATA_ARCHITECT_AGENT
- **Acceptance Criteria:** Audit logs searchable by date, user, action, resource with pagination
- **Done Checklist:**
  - [ ] /audit-logs page with TanStack Table
  - [ ] Server-side pagination
  - [ ] Filters: date range, user, action, resource
  - [ ] Detail modal for each entry
  - [ ] CSV export
  - [ ] Retention policy note
- **Output Artifacts:** `/apps/web/src/app/(dashboard)/audit-logs/page.tsx`

---

### EPIC 8 — POLISH & PRODUCTION READINESS

#### MILESTONE 8.1 — UI Polish

**TASK 8.1.1 — Design System Finalization**
- **Description:** Finalize all shadcn/ui components, design tokens, typography
- **Dependencies:** All frontend tasks from Epics 3-7
- **Risks:** Inconsistent component styles, accessibility gaps
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** All pages use consistent design tokens, components accessible (WCAG 2.1 AA)
- **Done Checklist:**
  - [ ] All shadcn/ui components installed and themed
  - [ ] Design tokens in CSS custom properties
  - [ ] Typography scale defined
  - [ ] Dark mode support (optional)
  - [ ] ARIA labels on all interactive elements
  - [ ] Keyboard navigation tested
- **Output Artifacts:** Updated component library

**TASK 8.1.2 — Responsive Design Audit**
- **Description:** Test all pages on mobile, tablet, desktop breakpoints
- **Dependencies:** 8.1.1
- **Risks:** Layout breaks on certain screen sizes
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** All pages functional and visually correct at 320px, 768px, 1024px, 1440px
- **Done Checklist:**
  - [ ] Mobile sidebar collapses to drawer
  - [ ] Tables scroll horizontally on mobile
  - [ ] Forms stack vertically on mobile
  - [ ] Touch targets >= 44px
  - [ ] No horizontal scroll at any breakpoint
- **Output Artifacts:** Responsive audit report

#### MILESTONE 8.2 — Performance Optimization

**TASK 8.2.1 — Frontend Performance**
- **Description:** Optimize bundle size, implement code splitting, memoization
- **Dependencies:** 8.1.1
- **Risks:** Over-optimization, breaking functionality
- **Owner Agent:** FRONTEND_ARCHITECT_AGENT
- **Review Agent:** QA_AGENT
- **Acceptance Criteria:** Lighthouse score >= 90 for Performance, First Contentful Paint < 1.5s
- **Done Checklist:**
  - [ ] Bundle analysis (webpack-bundle-analyzer)
  - [ ] Dynamic imports for heavy components
  - [ ] React.memo for expensive renders
  - [ ] useMemo/useCallback for expensive computations
  - [ ] Image optimization with Next.js Image
  - [ ] Font optimization (subset, preload)
- **Output Artifacts:** Bundle analysis report

**TASK 8.2.2 — Backend Performance**
- **Description:** Optimize database queries, add missing indexes, connection pooling
- **Dependencies:** 5.1.1, 6.1.1, 7.1.1
- **Risks:** Query plan changes after index additions
- **Owner Agent:** BACKEND_ARCHITECT_AGENT
- **Review Agent:** DATA_ARCHITECT_AGENT
- **Acceptance Criteria:** p95 API response time < 500ms, p99 < 2s
- **Done Checklist:**
  - [ ] EXPLAIN ANALYZE on all slow queries
  - [ ] N+1 query elimination
  - [ ] PgBouncer configured
  - [ ] Connection pool sizing tested
  - [ ] Cache hit ratio > 90%
- **Output Artifacts:** Performance benchmark report

#### MILESTONE 8.3 — Testing

**TASK 8.3.1 — Unit Test Completion**
- **Description:** Achieve 80%+ unit test coverage across all services
- **Dependencies:** All backend tasks from Epics 3-7
- **Risks:** Untested edge cases, flaky tests
- **Owner Agent:** QA_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** `pnpm test` passes, coverage >= 80% for services, 100% for guards
- **Done Checklist:**
  - [ ] All services have unit tests
  - [ ] All guards have unit tests (100% coverage)
  - [ ] All use cases have unit tests
  - [ ] Mocked Tyk responses tested
  - [ ] Edge cases tested (empty, max, invalid)
- **Output Artifacts:** Coverage report

**TASK 8.3.2 — Integration Tests**
- **Description:** Implement integration tests for API endpoints with real DB
- **Dependencies:** 8.3.1
- **Risks:** Test database pollution, flaky async tests
- **Owner Agent:** QA_AGENT
- **Review Agent:** BACKEND_ARCHITECT_AGENT
- **Acceptance Criteria:** All critical API flows tested end-to-end in isolation
- **Done Checklist:**
  - [ ] Test database with transactions (rollback after each test)
  - [ ] Auth flow integration tests
  - [ ] API CRUD integration tests
  - [ ] Key provisioning integration tests
  - [ ] Tenant isolation integration tests
  - [ ] RBAC integration tests
- **Output Artifacts:** Integration test suite

**TASK 8.3.3 — E2E Tests (Playwright)**
- **Description:** Implement E2E tests for critical user journeys
- **Dependencies:** 8.1.1
- **Risks:** Flaky UI tests, brittle selectors
- **Owner Agent:** QA_AGENT
- **Review Agent:** FRONTEND_ARCHITECT_AGENT
- **Acceptance Criteria:** All critical journeys pass consistently in CI
- **Done Checklist:**
  - [ ] Login → Dashboard journey
  - [ ] Create API journey
  - [ ] Create API Key journey
  - [ ] Assign role journey
  - [ ] View analytics journey
  - [ ] Audit log search journey
  - [ ] data-testid selectors on key elements
- **Output Artifacts:** `/apps/web/e2e/` test files

#### MILESTONE 8.4 — Production Deployment

**TASK 8.4.1 — Kubernetes Manifests**
- **Description:** Create Helm chart or K8s manifests for production deployment
- **Dependencies:** 1.2.2, 1.2.3
- **Risks:** Resource misconfiguration, missing probes
- **Owner Agent:** DEVOPS_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** Helm install deploys all services, health checks pass, HPA configured
- **Done Checklist:**
  - [ ] Namespace manifest
  - [ ] Deployment manifests (web, api)
  - [ ] Service manifests (ClusterIP)
  - [ ] Ingress manifest
  - [ ] ConfigMap for non-secret config
  - [ ] SealedSecrets for sensitive config
  - [ ] HPA manifests
  - [ ] Resource requests/limits
  - [ ] Liveness/readiness probes
  - [ ] Pod disruption budgets
- **Output Artifacts:** `/infra/k8s/` manifests or `/helm/` chart

**TASK 8.4.2 — Production Readiness Checklist**
- **Description:** Final verification of all production requirements
- **Dependencies:** All previous tasks
- **Risks:** Missing critical requirement
- **Owner Agent:** DELIVERY_MANAGER_AGENT
- **Review Agent:** SYSTEM_ARCHITECT_AGENT
- **Acceptance Criteria:** All items on checklist verified
- **Done Checklist:**
  - [ ] All tests passing
  - [ ] Security scan clean
  - [ ] Performance benchmarks met
  - [ ] Monitoring and alerting configured
  - [ ] Runbooks written
  - [ ] Backup strategy verified
  - [ ] DR runbook tested
  - [ ] Documentation complete
- **Output Artifacts:** Production readiness report

---

## SECTION 3 — AGENT EXECUTION MATRIX

| Task ID | Task Name | Primary Agent | Review Agent | Dependencies | Output Artifact |
|---------|-----------|---------------|--------------|--------------|-----------------|
| 1.1.1 | Initialize pnpm Workspace | DEVOPS_AGENT | BACKEND_ARCHITECT | None | package.json, pnpm-workspace.yaml |
| 1.1.2 | Turborepo Configuration | DEVOPS_AGENT | BACKEND_ARCHITECT | 1.1.1 | turbo.json |
| 1.1.3 | TypeScript Base Config | BACKEND_ARCHITECT | FRONTEND_ARCHITECT | 1.1.1 | tsconfig*.json |
| 1.1.4 | ESLint Flat Config | DEVOPS_AGENT | FRONTEND_ARCHITECT | 1.1.3 | eslint.config.js |
| 1.1.5 | Prettier Configuration | DEVOPS_AGENT | FRONTEND_ARCHITECT | 1.1.1 | .prettierrc |
| 1.1.6 | Editor Configuration | DEVOPS_AGENT | BACKEND_ARCHITECT | 1.1.5 | .editorconfig, .gitignore |
| 1.2.1 | Docker Compose Setup | DEVOPS_AGENT | SYSTEM_ARCHITECT | 1.1.1 | infra/docker-compose.yml |
| 1.2.2 | Next.js Dockerfile | DEVOPS_AGENT | FRONTEND_ARCHITECT | 1.1.1 | apps/web/Dockerfile |
| 1.2.3 | NestJS Dockerfile | DEVOPS_AGENT | BACKEND_ARCHITECT | 1.1.1 | apps/api/Dockerfile |
| 1.2.4 | Environment Templates | DEVOPS_AGENT | SYSTEM_ARCHITECT | 1.2.1 | .env.example files |
| 1.2.5 | Dev Bootstrap Script | DEVOPS_AGENT | QA_AGENT | 1.2.1, 1.2.4 | infra/scripts/setup.sh |
| 1.3.1 | CI Workflow | DEVOPS_AGENT | QA_AGENT | 1.1.1 | .github/workflows/ci.yml |
| 1.3.2 | CD Staging Workflow | DEVOPS_AGENT | SYSTEM_ARCHITECT | 1.3.1 | .github/workflows/cd-staging.yml |
| 1.3.3 | Dependabot Config | DEVOPS_AGENT | BACKEND_ARCHITECT | 1.1.1 | .github/dependabot.yml |
| 2.1.1 | Prisma Package Init | DATA_ARCHITECT | BACKEND_ARCHITECT | 1.1.1 | packages/database/* |
| 2.1.2 | Core Schema Models | DATA_ARCHITECT | BACKEND_ARCHITECT | 2.1.1 | schema.prisma |
| 2.1.3 | Database Migrations | DATA_ARCHITECT | BACKEND_ARCHITECT | 2.1.2 | migrations/, seed.ts |
| 2.1.4 | Database Indexing | DATA_ARCHITECT | SYSTEM_ARCHITECT | 2.1.2 | Updated schema.prisma |
| 2.2.1 | Redis Client Setup | BACKEND_ARCHITECT | SYSTEM_ARCHITECT | 1.2.1 | redis.module.ts |
| 2.2.2 | Cache Module | BACKEND_ARCHITECT | SYSTEM_ARCHITECT | 2.2.1 | cache.interceptor.ts |
| 2.3.1 | OTEL SDK (NestJS) | DEVOPS_AGENT | SYSTEM_ARCHITECT | 1.2.1 | otel.module.ts |
| 2.3.2 | OTEL SDK (Next.js) | DEVOPS_AGENT | FRONTEND_ARCHITECT | 2.3.1 | telemetry.ts |
| 3.1.1 | JWT Strategy | BACKEND_ARCHITECT | SYSTEM_ARCHITECT | 2.1.3 | jwt.strategy.ts |
| 3.1.2 | Auth Controller | BACKEND_ARCHITECT | QA_AGENT | 3.1.1 | auth.controller.ts |
| 3.1.3 | Auth Guards | BACKEND_ARCHITECT | SYSTEM_ARCHITECT | 3.1.1, 2.1.2 | guards/*.ts |
| 3.1.4 | Frontend Auth | FRONTEND_ARCHITECT | SYSTEM_ARCHITECT | 3.1.2 | login/page.tsx |
| 3.2.1 | RBAC Models | DATA_ARCHITECT | BACKEND_ARCHITECT | 2.1.3 | Updated schema, seed |
| 3.2.2 | Permission Service | BACKEND_ARCHITECT | QA_AGENT | 3.2.1, 3.1.3 | permission.service.ts |
| 4.1.1 | Tenant CRUD | BACKEND_ARCHITECT | DATA_ARCHITECT | 2.1.3, 3.1.3 | tenant.controller.ts |
| 4.1.2 | Tenant Isolation | DATA_ARCHITECT | SYSTEM_ARCHITECT | 4.1.1, 2.1.4 | RLS policies, Prisma middleware |
| 4.1.3 | Tenant Onboarding | BACKEND_ARCHITECT | QA_AGENT | 4.1.1, 3.1.2 | onboarding.service.ts |
| 4.2.1 | Tenant Switching | FRONTEND_ARCHITECT | BACKEND_ARCHITECT | 4.1.1 | tenant-switcher.tsx |
| 5.1.1 | API Definition Model | BACKEND_ARCHITECT | DATA_ARCHITECT | 2.1.3, 4.1.1 | api-definition.entity.ts |
| 5.1.2 | API Frontend Pages | FRONTEND_ARCHITECT | QA_AGENT | 5.1.1 | apis/pages |
| 5.2.1 | Tyk Client Service | BACKEND_ARCHITECT | SYSTEM_ARCHITECT | 3.1.1, 2.2.1 | tyk-client.service.ts |
| 5.2.2 | API Sync Pipeline | BACKEND_ARCHITECT | SYSTEM_ARCHITECT | 5.2.1, 5.1.1 | api-sync.service.ts |
| 5.2.3 | Circuit Breaker | BACKEND_ARCHITECT | SYSTEM_ARCHITECT | 5.2.1 | circuit-breaker.service.ts |
| 5.3.1 | API Health Check | BACKEND_ARCHITECT | QA_AGENT | 5.2.1 | api-health.service.ts |
| 6.1.1 | API Key Service | BACKEND_ARCHITECT | SYSTEM_ARCHITECT | 5.2.1, 4.1.1 | api-key.service.ts |
| 6.1.2 | Key Frontend Pages | FRONTEND_ARCHITECT | QA_AGENT | 6.1.1 | keys/pages |
| 6.2.1 | Quota Service | BACKEND_ARCHITECT | DATA_ARCHITECT | 6.1.1 | quota.service.ts |
| 6.2.2 | Quota Components | FRONTEND_ARCHITECT | QA_AGENT | 6.2.1 | quota-meter.tsx |
| 7.1.1 | Analytics Pipeline | BACKEND_ARCHITECT | DATA_ARCHITECT | 5.2.1 | analytics.controller.ts |
| 7.1.2 | Analytics Dashboard | FRONTEND_ARCHITECT | QA_AGENT | 7.1.1 | analytics/page.tsx |
| 7.2.1 | Audit Log Interceptor | BACKEND_ARCHITECT | QA_AGENT | 3.1.3, 2.1.2 | audit-log.interceptor.ts |
| 7.2.2 | Audit Log Viewer | FRONTEND_ARCHITECT | DATA_ARCHITECT | 7.2.1, 2.1.2 | audit-logs/page.tsx |
| 8.1.1 | Design System Finalize | FRONTEND_ARCHITECT | QA_AGENT | Epics 3-7 frontend | Component library |
| 8.1.2 | Responsive Audit | FRONTEND_ARCHITECT | QA_AGENT | 8.1.1 | Audit report |
| 8.2.1 | Frontend Performance | FRONTEND_ARCHITECT | QA_AGENT | 8.1.1 | Bundle analysis |
| 8.2.2 | Backend Performance | BACKEND_ARCHITECT | DATA_ARCHITECT | 5.1.1, 6.1.1, 7.1.1 | Perf benchmark |
| 8.3.1 | Unit Tests | QA_AGENT | BACKEND_ARCHITECT | All backend tasks | Coverage report |
| 8.3.2 | Integration Tests | QA_AGENT | BACKEND_ARCHITECT | 8.3.1 | Integration suite |
| 8.3.3 | E2E Tests | QA_AGENT | FRONTEND_ARCHITECT | 8.1.1 | Playwright tests |
| 8.4.1 | K8s Manifests | DEVOPS_AGENT | SYSTEM_ARCHITECT | 1.2.2, 1.2.3 | infra/k8s/* |
| 8.4.2 | Production Readiness | DELIVERY_MANAGER | SYSTEM_ARCHITECT | All tasks | PR report |

---

## SECTION 4 — MONOREPO TEMPLATE

The monorepo skeleton has been generated at `/home/famo/workspace/open-gateway`. Here's the verified structure:

### Generated Files Status

```
open-gateway/
├── package.json              ✅ Generated
├── pnpm-workspace.yaml       ✅ Generated
├── turbo.json                ✅ Generated
├── tsconfig.json             ✅ Generated
├── tsconfig.node.json        ✅ Generated
├── eslint.config.js          ✅ Generated
├── .prettierrc               ✅ Generated
├── .prettierignore           ✅ Generated
├── .editorconfig             ✅ Generated
├── .gitignore                ✅ Generated
├── .dockerignore             ✅ Generated
├── CHANGELOG.md              ✅ Generated
├── README.md                 ✅ Generated
├── LICENSE                   ✅ Generated
├── apps/
│   └── web/                  ✅ Partial (needs NestJS api app)
├── packages/
│   ├── config/               ✅ Generated
│   ├── database/             ✅ Partial
│   ├── types/                ✅ Partial
│   └── ui/                   ✅ Partial
├── infra/                    ⏳ In progress
├── docs/                     ⏳ In progress
├── scripts/                  ⏳ In progress
└── .github/                  ⏳ In progress
```

### Remaining Template Files to Generate

The following files still need to be created to complete the skeleton:

```
# Apps
apps/api/                          # NestJS application (missing)
apps/api/package.json
apps/api/tsconfig.json
apps/api/src/main.ts
apps/api/src/app.module.ts
apps/api/src/app.controller.ts
apps/api/src/app.service.ts
apps/api/.env.example
apps/api/Dockerfile

apps/web/Dockerfile                # Missing
apps/web/.env.example              # Verify complete

# Packages
packages/types/src/index.ts        # Verify complete
packages/types/src/auth.ts
packages/types/src/api.ts
packages/types/src/tenant.ts
packages/types/src/common.ts
packages/database/prisma/schema.prisma  # Verify complete
packages/database/prisma/seed.ts
packages/database/src/index.ts

# Infrastructure
infra/docker-compose.yml           # Verify complete
infra/k8s/                         # Verify manifests
infra/scripts/setup.sh

# GitHub
.github/workflows/ci.yml
.github/workflows/cd-staging.yml
.github/dependabot.yml
.github/PULL_REQUEST_TEMPLATE.md
.github/CODEOWNERS

# Docs
docs/architecture.md
docs/development.md
docs/deployment.md
```

---

## SECTION 5 — DOMAIN BLUEPRINT

### 5.1 Auth Domain

| Aspect | Definition |
|--------|-----------|
| **Responsibility** | User authentication, session management, token issuance |
| **Entities** | User, Session, RefreshToken |
| **Value Objects** | Email, PasswordHash, JWT |
| **Domain Services** | AuthenticationService, TokenService, PasswordService |
| **Domain Events** | UserLoggedIn, UserLoggedOut, PasswordChanged, AccountLocked |
| **Repositories** | UserRepository, SessionRepository |
| **Application Services** | LoginUseCase, RegisterUseCase, RefreshTokenUseCase, LogoutUseCase |
| **Contracts** | POST /auth/login, POST /auth/register, POST /auth/refresh, POST /auth/logout, GET /auth/me |
| **Guards** | JwtAuthGuard, LocalAuthGuard |

### 5.2 Users Domain

| Aspect | Definition |
|--------|-----------|
| **Responsibility** | User profile management, user-tenant associations |
| **Entities** | User, UserTenant |
| **Value Objects** | FullName, AvatarUrl |
| **Domain Services** | UserManagementService, TenantAssignmentService |
| **Domain Events** | UserCreated, UserUpdated, UserDeactivated, UserAssignedToTenant |
| **Repositories** | UserRepository, UserTenantRepository |
| **Application Services** | CreateUserUseCase, UpdateUserUseCase, AssignTenantUseCase, DeactivateUserUseCase |
| **Contracts** | GET /users, GET /users/:id, PATCH /users/:id, POST /users/:id/tenants, DELETE /users/:id/tenants/:tenantId |

### 5.3 Tenants Domain

| Aspect | Definition |
|--------|-----------|
| **Responsibility** | Tenant lifecycle, tenant configuration |
| **Entities** | Tenant, TenantConfig |
| **Value Objects** | TenantSlug, TenantPlan |
| **Domain Services** | TenantProvisioningService, TenantConfigService |
| **Domain Events** | TenantCreated, TenantUpdated, TenantSuspended, TenantArchived |
| **Repositories** | TenantRepository, TenantConfigRepository |
| **Application Services** | CreateTenantUseCase, UpdateTenantUseCase, SuspendTenantUseCase, ArchiveTenantUseCase |
| **Contracts** | POST /tenants, GET /tenants, GET /tenants/:id, PATCH /tenants/:id, DELETE /tenants/:id |

### 5.4 API Management Domain

| Aspect | Definition |
|--------|-----------|
| **Responsibility** | API definition lifecycle, Tyk synchronization |
| **Entities** | ApiDefinition, ApiHealth |
| **Value Objects** | ApiSlug, ProxyUrl, ListenPath, AuthType |
| **Domain Services** | ApiLifecycleService, TykSyncService, ApiHealthService |
| **Domain Events** | ApiCreated, ApiUpdated, ApiDeleted, ApiSynced, ApiSyncFailed, ApiHealthChanged |
| **Repositories** | ApiDefinitionRepository, ApiHealthRepository |
| **Application Services** | CreateApiUseCase, UpdateApiUseCase, DeleteApiUseCase, SyncApiToTykUseCase, ListApisQuery |
| **Contracts** | POST /apis, GET /apis, GET /apis/:id, PATCH /apis/:id, DELETE /apis/:id, GET /apis/:id/health |

### 5.5 Tyk Integration Domain

| Aspect | Definition |
|--------|-----------|
| **Responsibility** | Tyk Admin API communication, credential isolation, response transformation |
| **Entities** | TykPolicy, TykApiMapping |
| **Value Objects** | TykApiId, TykKeyId, TykPolicyId |
| **Domain Services** | TykClientService, TykResponseMapper, TykCredentialManager |
| **Domain Events** | TykApiCalled, TykSyncCompleted, TykSyncFailed, TykCircuitBreakerOpened |
| **Repositories** | TykPolicyRepository, TykApiMappingRepository |
| **Application Services** | CreateApiInTykUseCase, UpdateApiInTykUseCase, DeleteApiInTykUseCase, CreatePolicyInTykUseCase |
| **Contracts** | Internal only — NO external endpoints |
| **Security** | Admin key from env, NEVER logged, NEVER passed to frontend |

### 5.6 Keys Domain

| Aspect | Definition |
|--------|-----------|
| **Responsibility** | API key lifecycle, provisioning via Tyk, revocation |
| **Entities** | ApiKey, KeyMetadata |
| **Value Objects** | KeyName, KeyHash, KeyExpiration |
| **Domain Services** | KeyProvisioningService, KeyRevocationService |
| **Domain Events** | KeyCreated, KeyRevoked, KeyExpired, KeyQuotaExceeded |
| **Repositories** | ApiKeyRepository |
| **Application Services** | CreateKeyUseCase, RevokeKeyUseCase, ListKeysQuery, GetKeyUsageQuery |
| **Contracts** | POST /keys, GET /keys, GET /keys/:id, POST /keys/:id/revoke, GET /keys/:id/usage |

### 5.7 Quotas Domain

| Aspect | Definition |
|--------|-----------|
| **Responsibility** | Quota tracking, enforcement, reset scheduling |
| **Entities** | Quota, QuotaUsage |
| **Value Objects** | QuotaLimit, QuotaPeriod, QuotaResetTime |
| **Domain Services** | QuotaEnforcementService, QuotaResetService |
| **Domain Events** | QuotaUpdated, QuotaExceeded, QuotaReset |
| **Repositories** | QuotaRepository, QuotaUsageRepository |
| **Application Services** | SetQuotaUseCase, UpdateQuotaUseCase, CheckQuotaUseCase, ResetQuotaUseCase |
| **Contracts** | POST /quotas, GET /quotas, PATCH /quotas/:id |

### 5.8 Analytics Domain

| Aspect | Definition |
|--------|-----------|
| **Responsibility** | Usage data aggregation, metric collection, reporting |
| **Entities** | UsageMetric, AggregatedStat |
| **Value Objects** | DateRange, MetricValue |
| **Domain Services** | AnalyticsAggregationService, MetricCollectionService |
| **Domain Events** | AnalyticsAggregated, MetricThresholdExceeded |
| **Repositories** | AnalyticsRepository |
| **Application Services** | GetOverviewQuery, GetApiMetricsQuery, GetKeyMetricsQuery, ExportAnalyticsUseCase |
| **Contracts** | GET /analytics/overview, GET /analytics/apis, GET /analytics/keys |

### 5.9 Audit Domain

| Aspect | Definition |
|--------|-----------|
| **Responsibility** | Immutable audit trail, compliance logging, event capture |
| **Entities** | AuditLog |
| **Value Objects** | AuditAction, AuditResource, AuditDetails, CorrelationId |
| **Domain Services** | AuditCaptureService, AuditExportService |
| **Domain Events** | AuditLogCreated |
| **Repositories** | AuditLogRepository (append-only) |
| **Application Services** | RecordAuditUseCase, QueryAuditLogs, ExportAuditLogsUseCase |
| **Contracts** | GET /audit-logs, GET /audit-logs/:id, POST /audit-logs/export |

---

## SECTION 6 — DATABASE BLUEPRINT

### 6.1 Entity Relationship Diagram

```
┌──────────────────────┐       ┌──────────────────────────┐       ┌──────────────────────┐
│       USER           │       │      USER_TENANT         │       │      TENANT          │
├──────────────────────┤       ├──────────────────────────┤       ├──────────────────────┤
│ PK id       UUID     │──┐    │ PK user_id       UUID    │    ┌──│ PK id       UUID     │
│    email    VARCHAR  │  └───►│ PK tenant_id     UUID    │◄───┘  │    name     VARCHAR  │
│    name     VARCHAR  │       │    role          VARCHAR │       │    slug     VARCHAR  │◄── UNIQUE
│    password  VARCHAR │       │    is_default    BOOL    │       │    status   ENUM     │
│    status    ENUM    │       │    created_at    TIMESTZ │       │    plan     ENUM     │
│    created_at TIMESTZ│       └──────────────────────────┘       │    config   JSONB    │
│    updated_at TIMESTZ│                                          │    created_at TIMESTZ│
└──────────────────────┘                                          │    updated_at TIMESTZ│
        │                                                         └──────────────────────┘
        │                                                                   │
        │                              ┌────────────────────────────────────┤
        │                              │                                    │
        ▼                              ▼                                    ▼
┌──────────────────────┐  ┌──────────────────────┐  ┌──────────────────────────┐
│       ROLE           │  │    ROLE_PERMISSION   │  │     PERMISSION           │
├──────────────────────┤  ├──────────────────────┤  ├──────────────────────────┤
│ PK id       UUID     │  │ PK role_id    UUID   │  │ PK id          UUID      │
│    name     VARCHAR  │◄─┤ PK permission_id UUID│─►│    name        VARCHAR   │
│    tenant_id UUID    │  └──────────────────────┘  │    resource    VARCHAR   │
│    desc     TEXT     │                            │    action      VARCHAR   │
│    created_at TIMESTZ│  ┌──────────────────────┐  └──────────────────────────┘
└──────────────────────┘  │     API_DEFINITION   │
                          ├──────────────────────┤
                          │ PK id          UUID   │
┌──────────────────────┐  │    tenant_id    UUID  │── FK → TENANT
│      API_KEY         │  │    name         VARCHAR│
├──────────────────────┤  │    slug         VARCHAR│
│ PK id       UUID     │  │    tyk_api_id   VARCHAR│
│    tenant_id  UUID   │──┤    proxy_url    VARCHAR│
│    user_id    UUID   │  │    listen_path  VARCHAR│
│    name       VARCHAR│  │    auth_type    ENUM   │
│    tyk_key_id VARCHAR│  │    status       ENUM   │
│    status     ENUM   │  │    config       JSONB  │
│    expires_at TIMESTZ│  │    sync_status  ENUM   │
│    created_at TIMESTZ│  │    health_status ENUM  │
└──────────────────────┘  │    created_at   TIMESTZ│
                          │    updated_at   TIMESTZ│
┌──────────────────────┐  └──────────────────────────┘
│       QUOTA          │
├──────────────────────┤  ┌──────────────────────────┐
│ PK id       UUID     │  │      API_KEY             │
│    api_key_id UUID   │──┤ (detailed)               │
│    limit      INT    │  ├──────────────────────────┤
│    used       INT    │  │ PK id          UUID       │
│    period     ENUM   │  │    tenant_id     UUID     │
│    reset_at   TIMESTZ│──┤    user_id       UUID     │
│    created_at TIMESTZ│  │    name          VARCHAR   │
└──────────────────────┘  │    tyk_key_id    VARCHAR   │
                          │    key_hash      VARCHAR   │
┌──────────────────────┐  │    status        ENUM      │
│      AUDIT_LOG       │  │    expires_at    TIMESTZ   │
├──────────────────────┤  │    created_at    TIMESTZ   │
│ PK id       BIGSERIAL│  └──────────────────────────┘
│    tenant_id  UUID   │──
│    user_id    UUID   │──  ┌──────────────────────────┐
│    action     VARCHAR│    │        QUOTA             │
│    resource   VARCHAR│    ├──────────────────────────┤
│    details    JSONB  │    │ PK id          UUID       │
│    ip_address VARCHAR│    │    api_key_id    UUID     │──
│    corr_id    UUID   │    │    limit         INT      │
│    created_at TIMESTZ│───┤    used          INT      │
└──────────────────────┘    │    period        ENUM     │
   APPEND-ONLY              │    reset_at      TIMESTZ  │
   NO UPDATE/DELETE         └──────────────────────────┘
```

### 6.2 Prisma Schema Blueprint

```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ─── ENUMS ──────────────────────────────────────────────

enum UserStatus {
  ACTIVE
  INACTIVE
  SUSPENDED
}

enum TenantStatus {
  ACTIVE
  SUSPENDED
  ARCHIVED
}

enum TenantPlan {
  FREE
  STARTER
  PRO
  ENTERPRISE
}

enum ApiStatus {
  DRAFT
  ACTIVE
  DISABLED
}

enum ApiSyncStatus {
  PENDING
  SYNCED
  FAILED
}

enum ApiHealthStatus {
  HEALTHY
  DEGRADED
  DOWN
  UNKNOWN
}

enum ApiAuthType {
  NONE
  AUTH_TOKEN
  JWT
  OAUTH
}

enum ApiKeyStatus {
  ACTIVE
  REVOKED
  EXPIRED
}

enum QuotaPeriod {
  HOURLY
  DAILY
  WEEKLY
  MONTHLY
}

enum AuditAction {
  CREATED
  UPDATED
  DELETED
  REVOKED
  ASSIGNED
  UNASSIGNED
  LOGIN
  LOGOUT
  ROLE_CHANGED
  PERMISSION_GRANTED
  PERMISSION_REVOKED
  QUOTA_EXCEEDED
  SYNC_SUCCEEDED
  SYNC_FAILED
}

// ─── MODELS ─────────────────────────────────────────────

model User {
  id         String     @id @default(uuid())
  email      String     @unique
  name       String
  password   String
  status     UserStatus @default(ACTIVE)
  createdAt  DateTime   @default(now()) @map("created_at")
  updatedAt  DateTime   @updatedAt @map("updated_at")

  userTenants UserTenant[]
  apiKeys     ApiKey[]
  auditLogs   AuditLog[]

  @@map("users")
}

model Tenant {
  id        String       @id @default(uuid())
  name      String
  slug      String       @unique
  status    TenantStatus @default(ACTIVE)
  plan      TenantPlan   @default(FREE)
  config    Json?
  createdAt DateTime     @default(now()) @map("created_at")
  updatedAt DateTime     @updatedAt @map("updated_at")

  userTenants    UserTenant[]
  apiDefinitions ApiDefinition[]
  apiKeys        ApiKey[]
  roles          Role[]
  auditLogs      AuditLog[]

  @@map("tenants")
}

model UserTenant {
  userId     String   @map("user_id")
  tenantId   String   @map("tenant_id")
  role       String   @default("viewer")
  isDefault  Boolean  @default(false) @map("is_default")
  createdAt  DateTime @default(now()) @map("created_at")

  user   User   @relation(fields: [userId], references: [id], onDelete: Cascade)
  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@id([userId, tenantId])
  @@index([userId, tenantId])
  @@index([tenantId])
  @@map("user_tenants")
}

model Role {
  id          String   @id @default(uuid())
  name        String
  description String?
  tenantId    String   @map("tenant_id")
  createdAt   DateTime @default(now()) @map("created_at")

  tenant      Tenant           @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  permissions RolePermission[]

  @@unique([name, tenantId])
  @@index([tenantId])
  @@map("roles")
}

model Permission {
  id       String   @id @default(uuid())
  name     String
  resource String
  action   String

  roles RolePermission[]

  @@unique([resource, action])
  @@index([resource, action])
  @@map("permissions")
}

model RolePermission {
  roleId       String @map("role_id")
  permissionId String @map("permission_id")

  role       Role       @relation(fields: [roleId], references: [id], onDelete: Cascade)
  permission Permission @relation(fields: [permissionId], references: [id], onDelete: Cascade)

  @@id([roleId, permissionId])
  @@index([roleId])
  @@index([permissionId])
  @@map("role_permissions")
}

model ApiDefinition {
  id           String         @id @default(uuid())
  tenantId     String         @map("tenant_id")
  name         String
  slug         String
  tykApiId     String?        @map("tyk_api_id")
  proxyUrl     String         @map("proxy_url")
  listenPath   String         @map("listen_path")
  authType     ApiAuthType    @default(NONE) @map("auth_type")
  status       ApiStatus      @default(DRAFT)
  config       Json?
  syncStatus   ApiSyncStatus  @default(PENDING) @map("sync_status")
  healthStatus ApiHealthStatus @default(UNKNOWN) @map("health_status")
  createdAt    DateTime       @default(now()) @map("created_at")
  updatedAt    DateTime       @updatedAt @map("updated_at")

  tenant Tenant @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  apiKeys ApiKey[]

  @@unique([tenantId, slug])
  @@index([tenantId, status])
  @@index([tenantId, createdAt(sort: Desc)])
  @@map("api_definitions")
}

model ApiKey {
  id         String       @id @default(uuid())
  tenantId   String       @map("tenant_id")
  userId     String       @map("user_id")
  name       String
  tykKeyId   String?      @map("tyk_key_id")
  keyHash    String?      @map("key_hash")
  status     ApiKeyStatus @default(ACTIVE)
  expiresAt  DateTime?    @map("expires_at")
  createdAt  DateTime     @default(now()) @map("created_at")

  tenant   Tenant  @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user     User    @relation(fields: [userId], references: [id], onDelete: Cascade)
  apiDef   ApiDefinition? @relation(fields: [apiDefId], references: [id], onDelete: SetNull)
  apiDefId String?  @map("api_def_id")
  quotas   Quota[]

  @@index([tenantId, status])
  @@index([tenantId, createdAt(sort: Desc)])
  @@index([userId])
  @@index([apiDefId])
  @@map("api_keys")
}

model Quota {
  id        String      @id @default(uuid())
  apiKeyId  String      @map("api_key_id")
  limit     Int
  used      Int         @default(0)
  period    QuotaPeriod @default(MONTHLY)
  resetAt   DateTime    @map("reset_at")
  createdAt DateTime    @default(now()) @map("created_at")

  apiKey ApiKey @relation(fields: [apiKeyId], references: [id], onDelete: Cascade)

  @@index([apiKeyId])
  @@index([resetAt])
  @@map("quotas")
}

model AuditLog {
  id        BigInt      @id @default(autoincrement())
  tenantId  String?     @map("tenant_id")
  userId    String?     @map("user_id")
  action    AuditAction
  resource  String
  details   Json?
  ipAddress String?     @map("ip_address")
  corrId    String?     @map("correlation_id")
  createdAt DateTime    @default(now()) @map("created_at")

  tenant Tenant? @relation(fields: [tenantId], references: [id], onDelete: SetNull)
  user   User?   @relation(fields: [userId], references: [id], onDelete: SetNull)

  @@index([tenantId, createdAt(sort: Desc)])
  @@index([userId, createdAt(sort: Desc)])
  @@index([action])
  @@index([resource])
  @@map("audit_logs")
}
```

### 6.3 Indexing Strategy

| Table | Index | Type | Justification |
|-------|-------|------|---------------|
| users | email | UNIQUE | Login lookup |
| tenants | slug | UNIQUE | Tenant resolution |
| user_tenants | (user_id, tenant_id) | PRIMARY | Junction PK |
| user_tenants | (tenant_id) | BTREE | List users in tenant |
| roles | (name, tenant_id) | UNIQUE | Prevent duplicate role names |
| roles | (tenant_id) | BTREE | List roles for tenant |
| permissions | (resource, action) | UNIQUE | Prevent duplicate permissions |
| api_definitions | (tenant_id, slug) | UNIQUE | Prevent duplicate slugs |
| api_definitions | (tenant_id, status) | BTREE | Filter APIs by status |
| api_definitions | (tenant_id, created_at DESC) | BTREE | Recent APIs query |
| api_keys | (tenant_id, status) | BTREE | Filter keys by status |
| api_keys | (tenant_id, created_at DESC) | BTREE | Recent keys query |
| api_keys | (user_id) | BTREE | Keys created by user |
| api_keys | (api_def_id) | BTREE | Keys for specific API |
| quotas | (api_key_id) | BTREE | Quotas for key |
| quotas | (reset_at) | BTREE | Quota reset scheduler |
| audit_logs | (tenant_id, created_at DESC) | BTREE | Tenant audit history |
| audit_logs | (user_id, created_at DESC) | BTREE | User audit history |
| audit_logs | (action) | BTREE | Filter by action type |
| audit_logs | (resource) | BTREE | Filter by resource type |

### 6.4 Multi-Tenant Strategy

**Approach: Shared Schema with Row-Level Security (RLS)**

- All tenant-scoped tables include `tenant_id` column
- Prisma middleware automatically adds `where: { tenantId }` filter
- PostgreSQL RLS policies enforce tenant isolation at database level
- Connection pool (PgBouncer) shared across tenants
- Tenant context propagated via JWT `tenant_id` claim + `X-Tenant-ID` header
- Data leakage prevention: **defense in depth** — application-level (guards) + database-level (RLS)

### 6.5 Retention Strategy

| Data Type | Retention | Action |
|-----------|-----------|--------|
| Audit logs | 2 years | Move to cold storage (S3 Glacier), delete from primary |
| Analytics raw data | 90 days | Aggregate to daily summaries, delete raw |
| API keys (revoked) | Indefinite | Keep record, mark as REVOKED |
| API keys (expired) | 180 days | Soft delete, then hard delete |
| Users (deactivated) | Indefinite | Keep for compliance, anonymize PII after 7 years |
| Tenants (archived) | Indefinite | Keep with ARCHIVED status |

---

## SECTION 7 — UI BLUEPRINT

### 7.1 Route Tree

```
/                                   → Redirect to /login or /dashboard
├── (auth)/                         [Auth layout: centered card, no sidebar]
│   ├── login/page.tsx              → Login form
│   └── register/page.tsx           → Registration form (if enabled)
│
├── (dashboard)/                    [Dashboard layout: sidebar + header + main]
│   ├── layout.tsx                  → Sidebar, Header, Breadcrumbs
│   ├── page.tsx                    → Dashboard overview (widgets)
│   │
│   ├── apis/
│   │   ├── page.tsx                → API list (TanStack Table)
│   │   ├── new/page.tsx            → Create API (multi-step form)
│   │   └── [id]/
│   │       ├── page.tsx            → API detail
│   │       └── edit/page.tsx       → Edit API
│   │
│   ├── keys/
│   │   ├── page.tsx                → Key list (TanStack Table)
│   │   ├── new/page.tsx            → Create key (form with quota)
│   │   └── [id]/
│   │       └── page.tsx            → Key detail (masked key, usage)
│   │
│   ├── tenants/
│   │   ├── page.tsx                → Tenant list
│   │   ├── new/page.tsx            → Create tenant (onboarding wizard)
│   │   └── [id]/
│   │       ├── page.tsx            → Tenant detail
│   │       └── edit/page.tsx       → Edit tenant
│   │
│   ├── users/
│   │   ├── page.tsx                → User list
│   │   └── [id]/
│   │       └── page.tsx            → User detail + role assignment
│   │
│   ├── roles/
│   │   ├── page.tsx                → Role list
│   │   ├── new/page.tsx            → Create role + permissions
│   │   └── [id]/
│   │       └── page.tsx            → Role detail + edit permissions
│   │
│   ├── analytics/page.tsx          → Analytics dashboard (charts, metrics)
│   ├── audit-logs/page.tsx         → Audit log viewer (search, filter, export)
│   └── settings/
│       ├── page.tsx                → General settings
│       └── profile/page.tsx        → User profile
```

### 7.2 Layout Hierarchy

```
RootLayout (app/layout.tsx)
├── font setup, metadata, providers
├── ThemeProvider
├── QueryClientProvider (TanStack Query)
│
├── (auth) Layout
│   └── Centered card container
│       └── Login page
│
└── (dashboard) Layout
    ├── Sidebar (collapsible, responsive)
    │   ├── Logo
    │   ├── NavItem[] (Dashboard, APIs, Keys, Tenants, Users, Roles, Analytics, Audit, Settings)
    │   └── Tenant selector
    │
    ├── Header
    │   ├── Breadcrumbs
    │   ├── User menu
    │   └── Notifications
    │
    └── Main Content
        └── Page content (routes above)
```

### 7.3 Component Taxonomy

**Layout Components:**
- `Shell` — Root container with sidebar + header + main
- `Sidebar` — Navigation sidebar with collapsible behavior
- `Header` — Top bar with breadcrumbs, user menu
- `Breadcrumb` — Navigation trail
- `PageContainer` — Page wrapper with padding
- `TenantSelector` — Dropdown for tenant switching

**Data Components:**
- `DataTable<T>` — TanStack Table wrapper with pagination, sorting, filtering
- `DataColumn<T>` — Column definition helper
- `Pagination` — Server-side pagination controls
- `ColumnToggle` — Column visibility dropdown
- `EmptyState` — Shown when no data
- `Skeleton` — Loading placeholder

**Form Components:**
- `Form` — React Hook Form provider wrapper
- `FormField` — Field with label, input, error, description
- `FormSection` — Grouped fields with heading
- `FormActions` — Submit/cancel buttons
- `ValidationSummary` — Server validation error display

**Feedback Components:**
- `Toast` — Success/error notifications
- `AlertDialog` — Confirmation dialogs
- `Skeleton` — Loading state
- `ErrorBoundary` — Error fallback
- `Badge` — Status indicators

### 7.4 Design Tokens

```css
:root {
  /* Colors — Neutral */
  --background: 0 0% 100%;
  --foreground: 222.2 84% 4.9%;
  --card: 0 0% 100%;
  --card-foreground: 222.2 84% 4.9%;
  --popover: 0 0% 100%;
  --popover-foreground: 222.2 84% 4.9%;
  --muted: 210 40% 96.1%;
  --muted-foreground: 215.4 16.3% 46.9%;

  /* Colors — Brand */
  --primary: 222.2 47.4% 11.2%;
  --primary-foreground: 210 40% 98%;
  --secondary: 210 40% 96.1%;
  --secondary-foreground: 222.2 47.4% 11.2%;
  --accent: 210 40% 96.1%;
  --accent-foreground: 222.2 47.4% 11.2%;

  /* Colors — Semantic */
  --destructive: 0 84.2% 60.2%;
  --destructive-foreground: 210 40% 98%;
  --success: 142 76% 36%;
  --warning: 38 92% 50%;
  --info: 221 83% 53%;

  /* Colors — Border */
  --border: 214.3 31.8% 91.4%;
  --input: 214.3 31.8% 91.4%;
  --ring: 222.2 84% 4.9%;

  /* Spacing */
  --space-1: 0.25rem;   /* 4px */
  --space-2: 0.5rem;    /* 8px */
  --space-3: 0.75rem;   /* 12px */
  --space-4: 1rem;      /* 16px */
  --space-5: 1.25rem;   /* 20px */
  --space-6: 1.5rem;    /* 24px */
  --space-8: 2rem;      /* 32px */
  --space-10: 2.5rem;   /* 40px */
  --space-12: 3rem;     /* 48px */
  --space-16: 4rem;     /* 64px */

  /* Border Radius */
  --radius-sm: 0.25rem;
  --radius-md: 0.375rem;
  --radius-lg: 0.5rem;
  --radius-xl: 0.75rem;

  /* Shadows */
  --shadow-sm: 0 1px 2px 0 rgb(0 0 0 / 0.05);
  --shadow-md: 0 4px 6px -1px rgb(0 0 0 / 0.1);
  --shadow-lg: 0 10px 15px -3px rgb(0 0 0 / 0.1);

  /* Z-index */
  --z-dropdown: 100;
  --z-sticky: 200;
  --z-overlay: 300;
  --z-modal: 400;
  --z-toast: 500;

  /* Animation */
  --duration-fast: 150ms;
  --duration-normal: 200ms;
  --duration-slow: 300ms;
  --ease-default: cubic-bezier(0.4, 0, 0.2, 1);
}
```

### 7.5 Data Table Pattern

```tsx
// Standard DataTable pattern for all list pages
<DataTable
  columns={columns}         // ColumnDef[]
  data={data}               // T[]
  pagination={true}         // Server-side pagination
  sorting={true}            // Server-side sorting
  filtering={true}          // Server-side filtering
  selection={true}          // Row selection for bulk actions
  toolbar={<Toolbar />}     // Custom toolbar
  emptyState={<Empty />}    // Empty state component
/>
```

### 7.6 Modal Pattern

- Use shadcn/ui `Dialog` for confirmation dialogs
- Use shadcn/ui `Sheet` (drawer) for detail views
- Use `react-hook-form` for forms inside modals
- Modal stack managed by URL state (search params)
- Nested modals: detail opens in Sheet, edit opens in Dialog

### 7.7 Form Pattern

```tsx
// Standard form pattern
const form = useForm<FormValues>({
  resolver: zodResolver(schema),
  defaultValues,
  mode: 'onChange',
});

// Submit mutation uses TanStack Query mutation
const mutation = useCreateApi();

const onSubmit = form.handleSubmit(async (data) => {
  await mutation.mutateAsync(data);
  router.push('/apis');
});
```

---

## SECTION 8 — DELIVERY ROADMAP

### 8.1 MVP (Phase 1 — Weeks 1-4)

**Goal:** Core admin dashboard with auth, tenant management, API CRUD, and basic Tyk integration.

**Scope:**
- [x] Epic 1: Foundation (monorepo, CI/CD, Docker)
- [x] Epic 2: Core Infrastructure (DB, Redis, OTEL)
- [x] Epic 3: Auth (JWT, login, RBAC basics)
- [ ] Epic 4: Tenant CRUD + isolation
- [ ] Epic 5: API CRUD + Tyk sync (create, list, delete)
- [ ] Epic 8.1: Basic UI polish for MVP pages

**Deliverables:**
- Functional login → dashboard flow
- Create/view/delete APIs (synced to Tyk)
- Basic tenant management
- RBAC with 4 default roles
- Audit logging (basic)

### 8.2 Phase 2 (Weeks 5-8)

**Goal:** API key management, quotas, analytics dashboard.

**Scope:**
- [ ] Epic 6: API key lifecycle + quota management
- [ ] Epic 7: Analytics dashboard + audit log viewer
- [ ] Epic 5.3: API health monitoring
- [ ] Epic 8.2: Performance optimization

**Deliverables:**
- Create/revoke API keys with quotas
- Analytics page with charts
- Full audit log viewer with search/export
- API health indicators

### 8.3 Phase 3 (Weeks 9-12)

**Goal:** Production hardening, E2E tests, Kubernetes deployment.

**Scope:**
- [ ] Epic 8.3: Complete test suite (unit, integration, E2E)
- [ ] Epic 8.4: Kubernetes manifests, Helm chart
- [ ] Epic 8.1: Full design system, responsive audit
- [ ] Production readiness checklist

**Deliverables:**
- 80%+ test coverage
- Production-ready K8s deployment
- Responsive, accessible UI
- Monitoring and alerting

### 8.4 Scaling Roadmap (Post-MVP)

| Phase | Focus | Key Initiatives |
|-------|-------|----------------|
| **Scale 1** | Multi-region | Active-active deployment, geo-redundant DB, CDN |
| **Scale 2** | Microservices | Extract Auth, Tyk Integration, Analytics to separate services |
| **Scale 3** | Event-driven | Replace Redis pub/sub with Kafka, event sourcing for audit |
| **Scale 4** | Multi-tenant advanced | Per-tenant databases for enterprise, custom domains |
| **Scale 5** | Platform APIs | Public API for third-party integrations, webhooks |

---

## SECTION 9 — OPENCODE HANDOFF PACKAGE

### Handoff Task Catalog

Each task below is designed for a single agent execution pass in OpenCode.

---

#### TASK H-001: Create NestJS App Skeleton

**OBJECTIVE:** Create the complete NestJS application skeleton under `apps/api/`

**FILES TO CREATE:**
- `apps/api/package.json`
- `apps/api/tsconfig.json`
- `apps/api/tsconfig.build.json`
- `apps/api/nest-cli.json`
- `apps/api/src/main.ts`
- `apps/api/src/app.module.ts`
- `apps/api/src/app.controller.ts`
- `apps/api/src/app.service.ts`
- `apps/api/.env.example`
- `apps/api/Dockerfile`

**DEPENDENCIES:** Monorepo foundation (Epic 1 complete)

**PROMPT:**
```
Create a production-ready NestJS application at apps/api/ with the following:

1. package.json with NestJS 11 dependencies, @nestjs/config, @nestjs/jwt, @nestjs/passport, ioredis, @prisma/client, class-validator, helmet, cors
2. NestJS CLI config with standard sourceDir
3. main.ts with: ValidationPipe (transform: true, whitelist: true, forbidNonWhitelisted: true), Helmet, CORS (configured from env), global prefix '/api', port from env (default 4000), graceful shutdown
4. app.module.ts with: ConfigModule.forRoot (isGlobal: true, envFilePath), basic AppController and AppService
5. app.controller.ts with GET / returning { status: 'ok', timestamp }
6. .env.example with: PORT, DATABASE_URL, REDIS_URL, JWT_SECRET, JWT_EXPIRES_IN, TYK_ADMIN_URL, TYK_ADMIN_SECRET, NODE_ENV
7. Dockerfile with multi-stage build (deps → builder → production), non-root user, HEALTHCHECK

Use TypeScript strict mode. No business modules — only the skeleton.
```

**EXPECTED OUTPUT:** NestJS app starts on port 4000, returns health check, connects to config

**TEST CRITERIA:** `pnpm --filter @open-gateway/api start:dev` succeeds, GET /api returns health response

---

#### TASK H-002: Create Prisma Schema

**OBJECTIVE:** Create the complete Prisma schema with all models, relations, indexes

**FILES TO CREATE/UPDATE:**
- `packages/database/prisma/schema.prisma`

**DEPENDENCIES:** H-001 (NestJS app exists)

**PROMPT:**
```
Create a complete Prisma schema at packages/database/prisma/schema.prisma with these models:

User (id, email unique, name, password, status enum ACTIVE/INACTIVE/SUSPENDED, createdAt, updatedAt)
Tenant (id, name, slug unique, status enum ACTIVE/SUSPENDED/ARCHIVED, plan enum FREE/STARTER/PRO/ENTERPRISE, config Json, createdAt, updatedAt)
UserTenant (userId, tenantId, role, isDefault, createdAt) — composite PK
Role (id, name, description, tenantId, createdAt) — unique(name, tenantId)
Permission (id, name, resource, action) — unique(resource, action)
RolePermission (roleId, permissionId) — composite PK
ApiDefinition (id, tenantId, name, slug, tykApiId, proxyUrl, listenPath, authType enum, status enum, config Json, syncStatus enum, healthStatus enum, createdAt, updatedAt) — unique(tenantId, slug)
ApiKey (id, tenantId, userId, name, tykKeyId, keyHash, status enum, expiresAt, createdAt)
Quota (id, apiKeyId, limit, used, period enum, resetAt, createdAt)
AuditLog (id BigInt autoincrement, tenantId, userId, action enum, resource, details Json, ipAddress, correlationId, createdAt)

Include all foreign key relations, indexes for common query patterns, and proper @@map names.
```

**EXPECTED OUTPUT:** Valid Prisma schema that generates without errors

**TEST CRITERIA:** `pnpm db:generate` succeeds

---

#### TASK H-003: Create JWT Auth Module

**OBJECTIVE:** Implement complete JWT authentication in NestJS

**FILES TO CREATE:**
- `apps/api/src/modules/auth/auth.module.ts`
- `apps/api/src/modules/auth/controllers/auth.controller.ts`
- `apps/api/src/modules/auth/services/auth.service.ts`
- `apps/api/src/modules/auth/strategies/jwt.strategy.ts`
- `apps/api/src/modules/auth/dto/login.dto.ts`
- `apps/api/src/modules/auth/dto/register.dto.ts`
- `apps/api/src/common/guards/jwt-auth.guard.ts`
- `apps/api/src/common/decorators/current-user.decorator.ts`

**DEPENDENCIES:** H-001, H-002

**PROMPT:**
```
Implement JWT authentication module for NestJS:

1. AuthService: login(email, password) → validates user, returns { accessToken, refreshToken }, register(dto) → creates user with bcrypt hash, logout(token) → adds to blacklist
2. JwtStrategy: extracts JWT from cookie, validates, returns user payload
3. AuthController: POST /auth/login (returns JWT cookie), POST /auth/register, POST /auth/refresh, POST /auth/logout, GET /auth/me
4. JwtAuthGuard: extends AuthGuard('jwt')
5. @CurrentUser() decorator: extracts user from request
6. DTOs with class-validator: LoginDto (email, password), RegisterDto (email, name, password)
7. Password hashing with bcrypt (cost 12)
8. JWT: access token 15min, refresh token 7d, stored in httpOnly secure cookies

Return tokens via Set-Cookie headers. NEVER return tokens in response body.
```

**EXPECTED OUTPUT:** Authentication endpoints functional, JWT cookies set correctly

**TEST CRITERIA:** Integration test: login with valid credentials → receives cookie → GET /auth/me returns user

---

#### TASK H-004: Create RBAC System

**OBJECTIVE:** Implement role-based access control with guards

**FILES TO CREATE:**
- `apps/api/src/modules/permissions/permissions.module.ts`
- `apps/api/src/modules/permissions/services/permission.service.ts`
- `apps/api/src/common/guards/roles.guard.ts`
- `apps/api/src/common/guards/permissions.guard.ts`
- `apps/api/src/common/decorators/roles.decorator.ts`
- `apps/api/src/common/decorators/permissions.decorator.ts`

**DEPENDENCIES:** H-003, H-002

**PROMPT:**
```
Implement RBAC system for NestJS:

1. @Roles(...roles) decorator for controllers
2. @Permissions(...permissions) decorator (resource:action format)
3. RolesGuard: checks user's role against @Roles() decorator
4. PermissionsGuard: checks user's permissions via PermissionService against @Permissions() decorator
5. PermissionService: loads user roles and permissions from DB, caches in Redis (5min TTL)
6. Seed data creates 4 roles: super_admin (all permissions), admin (most), operator (limited), viewer (read-only)
7. Permission model: resource:action (e.g., "api:create", "key:read", "tenant:update")

Guards should work together: JwtAuthGuard → RolesGuard → PermissionsGuard
```

**EXPECTED OUTPUT:** Routes protected by @Roles() or @Permissions() deny unauthorized access

**TEST CRITERIA:** Integration test: viewer role cannot POST /apis, admin role can

---

#### TASK H-005: Create Tenant Module

**OBJECTIVE:** Implement tenant CRUD with isolation

**FILES TO CREATE:**
- `apps/api/src/modules/tenants/tenants.module.ts`
- `apps/api/src/modules/tenants/controllers/tenant.controller.ts`
- `apps/api/src/modules/tenants/services/tenant.service.ts`
- `apps/api/src/modules/tenants/dto/create-tenant.dto.ts`
- `apps/api/src/modules/tenants/dto/update-tenant.dto.ts`
- `apps/api/src/common/guards/tenant-isolation.guard.ts`
- `apps/api/src/common/decorators/current-tenant.decorator.ts`

**DEPENDENCIES:** H-003, H-004, H-002

**PROMPT:**
```
Implement tenant management module:

1. TenantController: POST /tenants, GET /tenants (paginated), GET /tenants/:id, PATCH /tenants/:id, DELETE /tenants/:id (soft delete)
2. TenantService: full CRUD with validation, slug uniqueness, soft delete
3. TenantIsolationGuard: extracts tenant_id from JWT, ensures user has access to tenant, injects tenant context
4. @CurrentTenant() decorator: returns current tenant ID
5. Create-tenant DTO: name, slug, plan (default FREE)
6. Update-tenant DTO: name, status (partial)
7. Prisma middleware: automatically adds tenant filter to all tenant-scoped queries

All tenant-scoped queries must include tenant_id filter automatically.
```

**EXPECTED OUTPUT:** Tenant CRUD functional, tenant isolation enforced

**TEST CRITERIA:** Integration test: user of tenant A cannot GET /apis for tenant B

---

#### TASK H-006: Create Tyk Integration Service

**OBJECTIVE:** Implement Tyk Admin API client with credential isolation

**FILES TO CREATE:**
- `apps/api/src/modules/tyk-integration/tyk-integration.module.ts`
- `apps/api/src/modules/tyk-integration/services/tyk-client.service.ts`
- `apps/api/src/modules/tyk-integration/services/api-sync.service.ts`
- `apps/api/src/modules/tyk-integration/dto/tyk-api-definition.dto.ts`

**DEPENDENCIES:** H-001, H-003

**PROMPT:**
```
Implement Tyk integration service:

1. TykClientService: HTTP client for Tyk Admin API, admin key from env (NEVER logged), type-safe request/response
2. Methods: createApi(tykDef), updateApi(tykDef, apiId), deleteApi(apiId), createKey(keyDef), deleteKey(keyId), getAnalytics(params)
3. ApiSyncService: on API create → map to Tyk format → call TykClientService.createApi → store tykApiId → update sync_status
4. Response sanitization: strip Tyk internal IDs from responses before returning to controllers
5. Error handling: map Tyk errors to domain errors, NEVER expose Tyk error details to frontend
6. DTO: CreateApiInput (simple domain model) → TykApiDefinition (complex Tyk format)

CRITICAL: Tyk admin key must NEVER appear in logs, responses, or error messages.
```

**EXPECTED OUTPUT:** Tyk client connects, creates APIs, sanitizes responses

**TEST CRITERIA:** Unit test with mocked Tyk responses, verify key never logged

---

#### TASK H-007: Create Circuit Breaker

**OBJECTIVE:** Implement circuit breaker pattern for Tyk calls

**FILES TO CREATE:**
- `apps/api/src/common/circuit-breaker/circuit-breaker.module.ts`
- `apps/api/src/common/circuit-breaker/circuit-breaker.service.ts`

**DEPENDENCIES:** H-006

**PROMPT:**
```
Implement circuit breaker for Tyk Admin API:

1. CircuitBreakerService: tracks failure count, state transitions (CLOSED → OPEN → HALF_OPEN → CLOSED)
2. Config: threshold=5 failures, resetTimeout=30s, halfOpenMaxCalls=2
3. Decorator: @UseCircuitBreaker('tyk') for methods
4. When OPEN: throws CircuitBreakerOpenError (caller can catch and queue operation)
5. Health endpoint: shows circuit state
6. Event emission: emit TykCircuitBreakerOpened event for audit logging

Use a simple in-memory implementation (no external library needed).
```

**EXPECTED OUTPUT:** After 5 consecutive Tyk failures, circuit opens, rejects calls

**TEST CRITERIA:** Unit test: simulate 5 failures → circuit opens → next call rejected immediately

---

#### TASK H-008: Create API Management Module

**OBJECTIVE:** Implement API definition CRUD with Tyk sync

**FILES TO CREATE:**
- `apps/api/src/modules/api-management/api-management.module.ts`
- `apps/api/src/modules/api-management/controllers/api.controller.ts`
- `apps/api/src/modules/api-management/services/api.service.ts`
- `apps/api/src/modules/api-management/dto/create-api.dto.ts`
- `apps/api/src/modules/api-management/dto/update-api.dto.ts`
- `apps/api/src/modules/api-management/dto/api-response.dto.ts`

**DEPENDENCIES:** H-005, H-006, H-007

**PROMPT:**
```
Implement API management module:

1. ApiController: POST /apis, GET /apis (paginated, filtered), GET /apis/:id, PATCH /apis/:id, DELETE /apis/:id
2. ApiService: CRUD with tenant scoping, triggers sync to Tyk on create/update/delete
3. On create: save to DB → call ApiSyncService → update sync_status → create audit log
4. On update: update DB → sync to Tyk → update status → audit log
5. On delete: soft delete → delete from Tyk → audit log
6. DTOs: CreateApiDto (name, slug, proxyUrl, listenPath, authType, config), UpdateApiDto (partial)
7. Response: ApiResponseDto with data + meta (pagination)
8. Circuit breaker applied to all Tyk calls

All routes protected by JwtAuthGuard and TenantIsolationGuard.
```

**EXPECTED OUTPUT:** API CRUD functional, synced to Tyk, audit logged

**TEST CRITERIA:** Integration test: create API → appears in DB → sync status = SYNCED

---

#### TASK H-009: Create API Key Module

**OBJECTIVE:** Implement API key lifecycle management

**FILES TO CREATE:**
- `apps/api/src/modules/keys/keys.module.ts`
- `apps/api/src/modules/keys/controllers/key.controller.ts`
- `apps/api/src/modules/keys/services/api-key.service.ts`
- `apps/api/src/modules/keys/dto/create-key.dto.ts`
- `apps/api/src/modules/keys/dto/key-response.dto.ts`

**DEPENDENCIES:** H-006, H-005

**PROMPT:**
```
Implement API key management module:

1. KeyController: POST /keys, GET /keys (paginated), GET /keys/:id, POST /keys/:id/revoke
2. ApiKeyService: create → provision in Tyk → return key value ONCE → store hash only
3. Revoke: call Tyk delete key → update status to REVOKED → audit log
4. List: filtered by tenant, status, with pagination
5. CreateKeyDto: name, apiDefId, expiresAt (optional), quotaLimit (optional)
6. KeyResponseDto: id, name, status, expiresAt, createdAt (NEVER return key value after creation)
7. On creation, return key value in a one-time response field

Key value must be shown exactly once on creation, then never again.
```

**EXPECTED OUTPUT:** Key creation returns value once, revoke works, list paginated

**TEST CRITERIA:** Integration test: create key → get value → revoke → key disabled in Tyk

---

#### TASK H-010: Create Dashboard Frontend Layout

**OBJECTIVE:** Implement the dashboard shell layout with sidebar and header

**FILES TO CREATE:**
- `apps/web/src/app/(dashboard)/layout.tsx`
- `apps/web/src/components/layout/sidebar.tsx`
- `apps/web/src/components/layout/header.tsx`
- `apps/web/src/components/layout/breadcrumb.tsx`
- `apps/web/src/components/layout/tenant-selector.tsx`

**DEPENDENCIES:** Monorepo foundation, web app exists

**PROMPT:**
```
Create the dashboard layout for Next.js App Router:

1. (dashboard)/layout.tsx: wraps all dashboard pages, includes Sidebar + Header + main content area
2. Sidebar: collapsible, responsive (hidden on mobile, toggleable via hamburger), nav items for each section, tenant selector at bottom
3. Header: breadcrumbs (auto-generated from route), user menu (avatar, name, logout), notification bell
4. Breadcrumb: auto-generates from route segments, supports custom labels
5. TenantSelector: dropdown showing user's tenants, switches current tenant (updates cookie/session, invalidates TanStack Query cache)

Use shadcn/ui components. Tailwind CSS for styling. Responsive design.
```

**EXPECTED OUTPUT:** Functional dashboard shell with navigation, responsive sidebar

**TEST CRITERIA:** Pages render inside layout, sidebar collapses on mobile, tenant selector switches context

---

#### TASK H-011: Create Login Page

**OBJECTIVE:** Implement login page with React Hook Form and zod validation

**FILES TO CREATE:**
- `apps/web/src/app/(auth)/layout.tsx`
- `apps/web/src/app/(auth)/login/page.tsx`
- `apps/web/src/components/auth/login-form.tsx`

**DEPENDENCIES:** H-010 (layout exists), H-003 (auth backend)

**PROMPT:**
```
Create login page for Next.js App Router:

1. (auth)/layout.tsx: centered card layout, no sidebar, minimal footer
2. Login page: centered card with email/password form, "Remember me" checkbox, "Forgot password" link
3. LoginForm: React Hook Form + zod validation (email format, password min 8 chars)
4. Submit: POST to /api/auth/login (proxy to NestJS), set cookie on success
5. On success: redirect to /dashboard
6. On error: display validation errors inline, show toast for server errors
7. Loading state: disabled submit button, spinner
8. CSRF token handling for mutation

Use shadcn/ui Form, Input, Button, Card components.
```

**EXPECTED OUTPUT:** Login form validates, submits, redirects on success

**TEST CRITERIA:** E2E: fill form → submit → redirect to dashboard → authenticated

---

#### TASK H-012: Create API List Page

**OBJECTIVE:** Implement API list with TanStack Table

**FILES TO CREATE:**
- `apps/web/src/app/(dashboard)/apis/page.tsx`
- `apps/web/src/components/apis/api-table.tsx`
- `apps/web/src/components/apis/api-columns.tsx`

**DEPENDENCIES:** H-008 (API backend), H-010 (layout)

**PROMPT:**
```
Create API list page with TanStack Table:

1. page.tsx: fetches APIs from GET /apis (server-side paginated), passes to DataTable
2. api-columns.tsx: columns for Name, Slug, Status, Auth Type, Health, Created, Actions (view, edit, delete)
3. api-table.tsx: DataTable wrapper with server-side pagination, sorting (by name, created_at), filtering (by status), row selection for bulk actions
4. Bulk actions: Enable, Disable, Delete (with confirmation)
5. Status badges: Draft (gray), Active (green), Disabled (red)
6. Health indicator: dot (green/yellow/red)
7. Empty state: "No APIs yet" with "Create API" button
8. Toolbar: search, status filter, create button

Use TanStack Table 8 with @tanstack/react-query for data fetching.
```

**EXPECTED OUTPUT:** Paginated, sortable, filterable API list with bulk actions

**TEST CRITERIA:** E2E: navigate to /apis → see table → sort → filter → select rows → bulk action

---

#### TASK H-013: Create Audit Log Interceptor

**OBJECTIVE:** Implement audit logging interceptor for all mutations

**FILES TO CREATE:**
- `apps/api/src/modules/audit/audit.module.ts`
- `apps/api/src/modules/audit/interceptors/audit-log.interceptor.ts`
- `apps/api/src/modules/audit/services/audit.service.ts`
- `apps/api/src/common/decorators/audit.decorator.ts`

**DEPENDENCIES:** H-003, H-002

**PROMPT:**
```
Implement audit logging system:

1. AuditLogInterceptor: captures all POST/PUT/DELETE/PATCH requests, extracts user_id, tenant_id, action, resource, details (diff of before/after for PATCH), IP, correlation ID
2. @Audit('action') decorator: specifies the audit action (e.g., @Audit('api:created'))
3. AuditService: writes to audit_logs table asynchronously (non-blocking), uses Prisma
4. Async write: fire-and-forget with error logging (don't block the response)
5. Correlation ID: from request header or generated
6. Details: for PATCH, capture the changed fields (compare before/after snapshot)

Append-only: no UPDATE or DELETE on audit_logs table.
```

**EXPECTED OUTPUT:** All mutations create audit log entries

**TEST CRITERIA:** Integration test: create API → audit log entry exists with correct action, user, tenant

---

#### TASK H-014: Create Analytics Backend

**OBJECTIVE:** Implement analytics aggregation endpoints

**FILES TO CREATE:**
- `apps/api/src/modules/analytics/analytics.module.ts`
- `apps/api/src/modules/analytics/controllers/analytics.controller.ts`
- `apps/api/src/modules/analytics/services/analytics.service.ts`

**DEPENDENCIES:** H-006 (Tyk integration for analytics data)

**PROMPT:**
```
Implement analytics module:

1. AnalyticsController: GET /analytics/overview, GET /analytics/apis, GET /analytics/keys
2. AnalyticsService: aggregates data from Tyk analytics API + local DB
3. Overview: total requests (30d), avg latency, error rate, active keys, top API by usage
4. Per-API: requests over time (daily), latency p50/p95/p99, error count, top consumers
5. Per-key: usage count, quota utilization, last used
6. Date range: default 30 days, query param ?range=7d|30d|90d
7. Caching: cache results in Redis for 5 minutes

Response format: { success: true, data: { metrics }, meta: { range, generatedAt } }
```

**EXPECTED OUTPUT:** Analytics endpoints return aggregated data

**TEST CRITERIA:** Integration test: call /analytics/overview → returns valid metrics

---

## APPENDIX A — DEFINITION OF DONE

Every task is considered **Done** when ALL of the following are true:

### Code Requirements
- [ ] TypeScript strict mode, zero errors
- [ ] ESLint passes with zero warnings
- [ ] Prettier formatted
- [ ] No `any` types (use `unknown` or proper types)
- [ ] No `console.log` in production code (use logger)
- [ ] No hardcoded values (use env vars or constants)
- [ ] Error handling implemented (try/catch, proper error types)
- [ ] Input validation on all external inputs

### Test Requirements
- [ ] Unit tests for business logic (80%+ coverage)
- [ ] Integration tests for API endpoints
- [ ] Guards have 100% unit test coverage
- [ ] Tests are deterministic (no flakiness)
- [ ] Mock external services (Tyk, Redis)

### Documentation Requirements
- [ ] JSDoc on public methods
- [ ] README updated if new service/module
- [ ] .env.example updated with new variables
- [ ] API contract documented (OpenAPI or typed DTOs)

### Review Requirements
- [ ] Code reviewed by designated review agent
- [ ] All review comments addressed
- [ ] PR description includes what and why

### Deployment Requirements
- [ ] Builds without errors (`pnpm build`)
- [ ] Docker image builds successfully
- [ ] Health check endpoint functional
- [ ] No secrets in code or config (env vars only)

### Security Requirements
- [ ] No hardcoded secrets
- [ ] No credentials in logs
- [ ] Input validated and sanitized
- [ ] Authentication/authorization verified on protected routes
- [ ] CORS configured correctly
- [ ] Rate limiting applied where appropriate

---

## APPENDIX B — RISK REGISTER

| Risk ID | Risk | Impact | Probability | Mitigation | Owner |
|---------|------|--------|-------------|------------|-------|
| R-001 | Tyk Admin API unavailable | High | Medium | Circuit breaker, queue for retry, degraded mode | BACKEND_ARCHITECT |
| R-002 | Tenant data leakage | Critical | Low | RLS policies, TenantIsolationGuard, integration tests | SYSTEM_ARCHITECT |
| R-003 | Tyk credentials exposed | Critical | Low | Env var only, never logged, code review | SYSTEM_ARCHITECT |
| R-004 | Database migration failure in production | High | Low | Test migrations on staging, zero-downtime patterns, rollback plan | DATA_ARCHITECT |
| R-005 | N+1 queries causing performance degradation | High | Medium | Prisma include optimization, EXPLAIN ANALYZE monitoring | DATA_ARCHITECT |
| R-006 | Redis cache stampede under load | Medium | Medium | Cache-aside pattern, request coalescing | BACKEND_ARCHITECT |
| R-007 | Bundle size exceeding performance budget | Medium | Medium | Bundle analysis, code splitting, dynamic imports | FRONTEND_ARCHITECT |
| R-008 | Flaky E2E tests blocking CI | Medium | High | data-testid selectors, retry logic, stable test data | QA_AGENT |
| R-009 | Dependency breaking changes | Medium | Medium | Dependabot with auto-PRs, CI catches breakage | DEVOPS_AGENT |
| R-010 | PostgreSQL connection exhaustion | High | Low | PgBouncer, connection pool sizing, monitoring | DEVOPS_AGENT |

---

*End of Sisyphus Master Plan v1.0.0*