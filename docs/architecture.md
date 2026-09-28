# Architecture

> System architecture decisions, module design, and technical rationale for MIRQAB

## Table of Contents

1. [High-Level Architecture](#high-level-architecture)
2. [Module Dependency Graph](#module-dependency-graph)
3. [Authentication Flow](#authentication-flow)
4. [API Creation Flow](#api-creation-flow)
5. [Key Provisioning Flow](#key-provisioning-flow)
6. [Security Architecture](#security-architecture)
7. [Multi-Tenant Isolation](#multi-tenant-isolation)
8. [Clean Architecture Per Module](#clean-architecture-per-module)
9. [Architectural Decision Records (ADRs)](#architectural-decision-records-adrs)

---

## High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              EXTERNAL WORLD                                  │
│                                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌─────────────────────────────┐    │
│  │   Browser    │    │  Tyk Gateway │    │   Tyk Gateway REST API      │    │
│  │  (Admin UI)  │    │  (Traffic)   │    │   API (REST)                │    │
│  └──────┬───────┘    └──────┬───────┘    └──────────┬──────────────────┘    │
│         │                   │                       │                        │
│         │  HTTPS            │  API Traffic          │  Admin API             │
│         │                   │                       │  (REST)                │
│         ▼                   ▼                       ▼                        │
├─────────┼───────────────────┼───────────────────────┼────────────────────────┤
│         │                   │                       │                        │
│  ┌──────▼──────┐           │               ┌───────▼───────────────┐        │
│  │ Next.js 15  │           │               │     NestJS 11         │        │
│  │  (Web App)  │───────────┼──────────────►│     (API Server)      │        │
│  │             │  REST/    │  ONLY NestJS  │                       │        │
│  │ - SSR pages │  JSON     │  calls Tyk    │ - Auth (JWT/OIDC)     │        │
│  │ - Dashboard │           │               │ - API CRUD            │        │
│  │ - Tables    │           │               │ - Key management      │        │
│  │ - Forms     │           │               │ - Tyk proxy           │        │
│  │ - Analytics │           │               │ - Audit logging       │        │
│  └──────┬──────┘           │               └───────┬───────────────┘        │
│         │                   │                       │                        │
│         │                   │               ┌───────▼───────────────┐        │
│         │                   │               │   PostgreSQL 16       │        │
│         │                   │               │   + Prisma 6          │        │
│         │                   │               │                       │        │
│         │                   │               │ - Users, Roles        │        │
│         │                   │               │ - Tenants             │        │
│         │                   │               │ - API definitions     │        │
│         │                   │               │ - API keys, Quotas    │        │
│         │                   │               │ - Audit logs          │        │
│         │                   │               └───────────────────────┘        │
│         │                   │                                                │
│         │                   │               ┌───────────────────────┐        │
│         │                   │               │     Redis 7           │        │
│         │                   │               │                       │        │
│         │                   │               │ - Cache               │        │
│         │                   │               │ - Rate limiting       │        │
│         │                   │               │ - Sessions            │        │
│         │                   │               │ - Pub/Sub (events)    │        │
│         │                   │               └───────────────────────┘        │
│         │                   │                                                │
├─────────┴───────────────────┴────────────────────────────────────────────────┤
│                              OBSERVABILITY                                   │
│  ┌──────────────────────────────────────────────────────────────────────┐    │
│  │  OpenTelemetry Collector → Prometheus + Grafana + Loki + Tempo      │    │
│  └──────────────────────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────────────────────┘
```

**Key design principles:**
- **Frontend never connects to Tyk** — only NestJS holds Tyk credentials
- **Defense in depth** — 5 security layers (see [Security](#security-architecture))
- **Multi-tenant isolation** — shared schema with RLS + application guards
- **Clean architecture** — each module uses port/adapter interfaces for future microservices extraction

---

## Module Dependency Graph

```
AuthModule ──────────────────────────────────────────────► All modules (guards)
TenantModule ────────────────────────────────────────────► All data modules (isolation)
ApiManagementModule ───► TykIntegrationModule ───────────► External Tyk API
KeysModule ────────────► TykIntegrationModule ───────────► External Tyk API
QuotasModule ──────────► KeysModule
AnalyticsModule ───────► TykIntegrationModule (analytics data)
AuditModule ─────────────────────────────────────────────► All modules (interceptor)
AuditModule ───────────► AnalyticsModule (audit-row-to-traffic link, v1)
```

### Module Details

| Module | Exports | External Dependencies | Internal Dependencies |
|--------|---------|----------------------|----------------------|
| **AuthModule** | Token verification, session resolution (`GET /auth/me`) | Ory Hydra (JWKS), Ory Keto | Prisma |
| **TenantModule** | Tenant CRUD, user-tenant mapping | - | Prisma |
| **ApiManagementModule** | API definition CRUD, Tyk sync | TykIntegrationModule | Prisma, Auth guards, Tenant guards |
| **TykIntegrationModule** | TykClientService (create/update/delete APIs & keys) | Tyk Gateway REST API (HTTP) | CircuitBreaker |
| **KeysModule** | API key lifecycle (create, revoke, expire) | TykIntegrationModule | Prisma, Auth guards |
| **QuotasModule** | Per-key usage limits | - | Prisma |
| **AnalyticsModule** | Usage metrics, time-series, captured request/response traffic (redacted) | TykIntegrationModule | Prisma |
| **AuditModule** | Append-only audit log; an audit row for an API can show that API's rolled-up traffic (v1) | - | Prisma, Interceptors, AnalyticsModule |

---

## Authentication Flow

There is no local `POST /auth/login`, `/auth/register` or `/auth/refresh` any more — login is an
**Ory Kratos** self-service flow, tokens are minted by **Ory Hydra**, and the only surviving local
route is `GET /auth/me`. See `docs/security.md`'s [JWT Security](./security.md#jwt-security) and
[Password Policy](./security.md#password-policy) sections for the full rationale.

```
Browser has no session (middleware.ts redirects here, or "Sign in" is clicked)
    │
    ▼
┌──────────────────────────────────────────────────┐
│ 1. GET /oauth2/authorize (apps/web)               │
│    - Generates PKCE verifier/challenge + state    │
│    - Stores them in the oauth2_flow cookie        │
│    - Redirects to Hydra: GET /oauth2/auth         │
└────────────┬───────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ 2. Hydra has no browser session → redirects to    │
│    its `urls.login` target: GET /oauth2/login     │
│    (apps/web), carrying a login_challenge         │
└────────────┬───────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ 3. No Kratos session either → redirect to Kratos: │
│    GET /self-service/login/browser                │
│    (login_challenge riding in return_to).         │
│    Kratos serves its own login UI                 │
└────────────┬───────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ 4. Browser submits email/password to Kratos       │
│    directly. Kratos verifies (Argon2id, or a       │
│    legacy bcrypt hash by its stored prefix), sets  │
│    its own session cookie, then redirects back to  │
│    return_to → GET /oauth2/login (apps/web)        │
└────────────┬───────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ 5. apps/web reads the Kratos session, resolves or  │
│    provisions the matching Postgres User row, and  │
│    calls Hydra's admin API to accept the login     │
│    request (subject = Postgres User.id)            │
└────────────┬───────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ 6. Hydra redirects to its `urls.consent` target:   │
│    GET /oauth2/consent (apps/web). The dashboard   │
│    client is first-party (skip_consent) and never  │
│    normally lands here; auto-accepted if it does   │
└────────────┬───────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ 7. Hydra redirects to the dashboard's redirect_uri │
│    with an authorization code:                    │
│    GET /oauth2/callback (apps/web)                 │
│    - Verifies state against the oauth2_flow cookie │
│    - Exchanges the code (+ PKCE verifier) for      │
│      tokens via Hydra's token endpoint             │
│    - Sets access_token / refresh_token cookies     │
└────────────┬───────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ 8. Browser now has a session. Every dashboard      │
│    request sends the access_token cookie;          │
│    apps/web forwards it to NestJS as               │
│    Authorization: Bearer <token>                   │
└────────────┬───────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ 9. NestJS: JwtStrategy verifies the token against  │
│    Hydra's JWKS (RS256), reads only `sub`.         │
│    AuthService#resolveSession rebuilds the session │
│    from scratch — Keto (membership) + Postgres     │
│    (role → permissions) — on EVERY request, e.g.   │
│    GET /auth/me                                    │
└────────────┬───────────────────────────────────────┘
             ▼
┌──────────────────────────────────────────────────┐
│ 10. Token expiring: apps/web's GET /oauth2/refresh │
│     uses Hydra's refresh_token grant for a new     │
│     access/refresh pair and re-sets the cookies.   │
│     NestJS has no refresh endpoint of its own      │
└──────────────────────────────────────────────────┘
```

### Access Token Claims

Only `sub` (the Postgres `User.id`) is read out of the token — Hydra's token hook is off, so no
email, roles, tenant or permission claims exist on it. See `docs/security.md`'s
[Session Resolution](./security.md#session-resolution-postgres--ory-keto--why-its-split-this-way)
for why role/tenant data is resolved per-request instead of being embedded here.

```json
{
  "sub": "user-uuid",
  "iat": 1712500000,
  "exp": 1712503600
}
```

### Cookie Configuration

| Cookie | httpOnly | secure | SameSite | TTL |
|--------|----------|--------|----------|-----|
| `access_token` | true | true in prod (`COOKIE_SECURE`) | Lax | 1 hour (Hydra access token TTL) |
| `refresh_token` | true | true in prod (`COOKIE_SECURE`) | Lax | 720 hours / 30 days |
| `oauth2_flow` | true | true in prod (`COOKIE_SECURE`) | Lax | 10 minutes, scoped to `/oauth2` |

---

## API Creation Flow

```
User clicks "Create API" in dashboard
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. Frontend sends POST /apis with body: │
│    {                                     │
│      "name": "My API",                   │
│      "slug": "my-api",                   │
│      "proxyUrl": "https://api.target.io",│
│      "listenPath": "/my-api",            │
│      "authType": "AUTH_TOKEN"            │
│    }                                     │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ 2. NestJS: ApiManagementController       │
│    - Validates DTO (class-validator)     │
│    - Extracts tenantId from JWT          │
│    - Calls ApiManagementService.create()  │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ 3. NestJS: ApiManagementService          │
│    a. Create API definition in DB:       │
│       Prisma apiDefinition.create()      │
│       → status: DRAFT, syncStatus: PENDING│
│    b. Build Tyk API definition object    │
│    c. Call TykIntegrationService          │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ 4. NestJS: TykIntegrationService         │
│    a. POST to Tyk gateway API: /apis     │
│       (via TykClientService)             │
│    b. Circuit breaker protects call      │
│    c. Sanitize response (remove org_id,  │
│       internal_id, hook_references)      │
│    d. Extract tykApiId from response     │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ 5. NestJS: ApiManagementService          │
│    a. Update DB record:                  │
│       - tykApiId = returned ID           │
│       - status = ACTIVE                  │
│       - syncStatus = SYNCED              │
│    b. Log audit event:                   │
│       AuditLog.CREATED for api_definition │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ 6. Return to frontend:                  │
│    {                                     │
│      "id": "uuid",                       │
│      "name": "My API",                   │
│      "status": "ACTIVE",                 │
│      "syncStatus": "SYNCED",             │
│      "createdAt": "2024-..."             │
│    }                                     │
└─────────────────────────────────────────┘
```

### Error Handling

If Tyk API call fails:
- `syncStatus` remains `PENDING` or transitions to `FAILED`
- `healthStatus` set to `UNKNOWN`
- Error logged (NEVER Tyk internals exposed)
- Audit event: `AuditLog.SYNC_FAILED`
- Frontend receives partial success (DB record created, sync pending)
- User can manually retry sync via `POST /apis/:id/sync`

---

## Key Provisioning Flow

```
User clicks "Create Key" → assigns to API definition
    │
    ▼
┌─────────────────────────────────────────┐
│ 1. POST /keys with body:                │
│    {                                     │
│      "name": "Client App Key",           │
│      "apiDefId": "api-def-uuid",        │
│      "expiresAt": "2025-12-31"           │
│    }                                     │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ 2. NestJS: KeysService.create()         │
│    a. Look up API definition → tykApiId │
│    b. Build Tyk key definition:         │
│       {                                 │
│         "allowance": 1000,              │
│         "rate": 10,                     │
│         "per": 1,                       │
│         "expires": <timestamp>,         │
│         "api_id": "<tykApiId>"          │
│       }                                 │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ 3. TykClientService.createKey()         │
│    a. POST to Tyk gateway: /keys/create │
│    b. Circuit breaker protects call     │
│    c. Sanitize response                 │
│    d. Extract keyId and raw key value   │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ 4. KeysService:                         │
│    a. Hash the raw key value (SHA-256)  │
│    b. Store in DB:                      │
│       - tykKeyId = returned Tyk ID      │
│       - keyHash = SHA-256 hash          │
│       - status = ACTIVE                 │
│    c. Return the raw key ONCE to user   │
│    d. NEVER store the raw key in plain  │
│    e. Log audit: CREATED for api_key    │
└────────────┬────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────┐
│ 5. Frontend shows key to user:          │
│    ⚠️ This key will only be shown once! │
│    Copy and store it securely.          │
│                                         │
│    Your API key:                        │
│    a1b2c3d4e5f6g7h8i9j0                 │
│                                         │
│    [ Copy ] [ Done ]                    │
└─────────────────────────────────────────┘
```

---

## Security Architecture

### 5-Layer Defense in Depth

```
┌────────────────────────────────────────────────────────────────┐
│  Layer 1: Network Isolation                                    │
│  ─────────────────────────                                     │
│  • Private subnets for DB, Redis, Tyk Admin                    │
│  • Deny-all network policies (K8s)                             │
│  • Tyk Admin only reachable from NestJS pod IPs               │
│  • mTLS via service mesh (production)                          │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  Layer 2: AuthN / AuthZ (Ory Hydra + Kratos + Keto)            │
│  ─────────────────────                                         │
│  • Hydra-issued OAuth2/OIDC access tokens (1h), RS256/JWKS     │
│  • Hydra refresh tokens (720h/30d), refresh grant, not rotated │
│  • httpOnly, SameSite=Lax, secure in prod cookies              │
│  • RBAC roles: super_admin, admin, operator, viewer            │
│  • ABAC: tenant ownership enforced on every query             │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  Layer 3: Data Protection                                      │
│  ──────────────────────                                        │
│  • TLS 1.3 everywhere (browser → Next.js → NestJS → DB)       │
│  • AES-256 at rest (disk encryption)                           │
│  • Field-level encryption for secrets (Vault Transit)          │
│  • PostgreSQL Row-Level Security (RLS)                         │
│  • Prisma parameterized queries (no SQL injection)             │
│  • Argon2id password hashing (Ory Kratos, not this app)        │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  Layer 4: Application Security                                │
│  ────────────────────────────                                  │
│  • class-validator DTOs on all endpoints                      │
│  • Zod validation on frontend inputs                          │
│  • Helmet CSP headers on NestJS                               │
│  • CORS whitelist (only allowed origins)                       │
│  • Rate limiting: global + per-endpoint                       │
│  • Circuit breakers on Tyk calls                              │
│  • React auto-escaping (no XSS)                               │
│  • No dangerouslySetInnerHTML without sanitization            │
└────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌────────────────────────────────────────────────────────────────┐
│  Layer 5: Supply Chain Security                               │
│  ──────────────────────────────────                            │
│  • Dependabot weekly dependency updates                       │
│  • npm audit (block on critical vulnerabilities)              │
│  • Trivy container image scanning                             │
│  • Syft SBOM generation                                       │
│  • Cosign signed container images                             │
└────────────────────────────────────────────────────────────────┘
```

---

## Multi-Tenant Isolation

### Strategy: Shared Schema with Row-Level Security

All tenants share the same database tables. Isolation is enforced at **three layers**:

```
┌─────────────────────────────────────────────────────┐
│  Layer A: Application (Prisma middleware)           │
│  ──────────────────────────────────                 │
│  Every query is automatically scoped to tenantId:   │
│  prisma.apiDefinition.findMany()                    │
│    → WHERE tenant_id = 'current-tenant-uuid'        │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│  Layer B: Guards (NestJS)                           │
│  ──────────────────────                             │
│  TenantGuard validates tenant ownership:             │
│  - Extracts tenant_id from JWT                       │
│  - Validates user has access to this tenant          │
│  - Attaches tenantId to request context              │
└─────────────────────────────────────────────────────┘
                      │
                      ▼
┌─────────────────────────────────────────────────────┐
│  Layer C: Database (PostgreSQL RLS)                 │
│  ────────────────────────────────────────           │
│  Row-level policies on all multi-tenant tables:     │
│  CREATE POLICY tenant_isolation ON api_definitions  │
│    USING (tenant_id = current_setting('app.tenant_id'));│
└─────────────────────────────────────────────────────┘
```

### Tenant-Aware Query Flow

```
Request arrives with JWT
    │
    ▼
JwtGuard: validates signature, extracts tenant_id
    │
    ▼
TenantGuard: validates user belongs to tenant_id
    │
    ▼
Controller: calls Service with tenantId from request
    │
    ▼
Service: Prisma query includes { where: { tenantId } }
    │
    ▼
Database: RLS policy double-checks tenant_id match
    │
    ▼
Result: only records for this tenant are returned
```

---

## Clean Architecture Per Module

Each NestJS module follows **hexagonal architecture** (ports & adapters):

```
┌───────────────────────────────────────────────────────────────┐
│  Module (e.g., ApiManagementModule)                           │
│                                                               │
│  ┌─────────────────────────────────────────────────────────┐  │
│  │                    ADAPTER LAYER                         │  │
│  │                                                         │  │
│  │  ┌──────────────────┐       ┌───────────────────────┐  │  │
│  │  │ Controller       │       │ DTOs (class-validator) │  │  │
│  │  │ (HTTP endpoints) │       │ (input validation)     │  │  │
│  │  └────────┬─────────┘       └───────────┬───────────┘  │  │
│  │           │                             │              │  │
│  │           ▼                             ▼              │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │               PORT LAYER                          │  │  │
│  │  │  ┌─────────────────────────────────────────────┐ │  │  │
│  │  │  │ Service Interface                           │ │  │  │
│  │  │  │ (defines what the module does)              │ │  │  │
│  │  │  │ - create(dto, tenantId)                     │ │  │  │
│  │  │  │ - findAll(tenantId, page, pageSize)         │ │  │  │
│  │  │  │ - update(id, dto, tenantId)                 │ │  │  │
│  │  │  │ - delete(id, tenantId)                      │ │  │  │
│  │  │  │ - syncToTyk(id)                             │ │  │  │
│  │  │  └─────────────────────────────────────────────┘ │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  │           │                                             │  │
│  │           ▼                                             │  │
│  │  ┌──────────────────────────────────────────────────┐  │  │
│  │  │           INFRASTRUCTURE LAYER                    │  │  │
│  │  │                                                   │  │  │
│  │  │  ┌──────────────┐  ┌──────────────────────────┐  │  │  │
│  │  │  │ Prisma       │  │ TykIntegrationService    │  │  │  │
│  │  │  │ Service      │  │ (external API adapter)   │  │  │  │
│  │  │  │ (DB access)  │  │                          │  │  │  │
│  │  │  └──────────────┘  └──────────────────────────┘  │  │  │
│  │  └──────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────┘  │
└───────────────────────────────────────────────────────────────┘
```

**Why this matters:** Each module's **port layer** (service interface) defines what the module does without specifying how. The infrastructure adapters (Prisma, Tyk client) implement the how. This means:

- Modules can be unit-tested by mocking adapters
- If we extract a module to a microservice later, the port interface becomes the gRPC/REST contract
- Tyk integration is isolated — switching API gateways only requires a new adapter, not rewriting the whole module

---

## Architectural Decision Records (ADRs)

### ADR-001: Monorepo with pnpm + Turborepo

**Status:** Accepted

**Decision:** Use pnpm workspaces with Turborepo for task orchestration.

**Rationale:**
- Single source of truth for types and shared code
- Atomic commits across frontend and backend
- Turborepo caching speeds up CI (only affected packages rebuild)
- pnpm's strict dependency model prevents phantom dependencies
- Workspace protocol (`workspace:*`) ensures consistent versions

**Alternatives considered:**
- npm workspaces — slower, less strict dependency resolution
- yarn workspaces — larger install footprint, more complex
- Separate repositories with git submodules — painful cross-repo changes

**Consequences:**
- All team members must use pnpm
- CI must install all workspace dependencies
- Shared packages (`@open-gateway/types`, `@open-gateway/database`) must be rebuilt on change

---

### ADR-002: Next.js App Router Only

**Status:** Accepted

**Decision:** Use Next.js 15 App Router exclusively. No pages router.

**Rationale:**
- Server Components for better performance and security
- Built-in data fetching patterns (parallel, sequential)
- Better SEO support
- Pages router is in maintenance mode
- Route groups (`(auth)`, `(dashboard)`) enable clean layout separation

**Consequences:**
- All data fetching uses Server Components or TanStack Query client-side
- No `getServerSideProps` / `getStaticProps` — use `fetch()` in Server Components

---

### ADR-003: NestJS Modular Architecture with Hexagonal Pattern

**Status:** Accepted

**Decision:** Use NestJS with hexagonal/clean architecture per module.

**Rationale:**
- Each module is independently testable
- Ports/adapters pattern enables future microservices extraction
- Dependency injection supports testing with mocks
- Industry-standard for Node.js enterprise backends

**Consequences:**
- More boilerplate per module (interfaces, DTOs)
- Requires discipline to maintain layer boundaries
- Controllers should never contain business logic

---

### ADR-004: Frontend Never Connects to Tyk Directly

**Status:** Accepted

**Decision:** Only the NestJS backend accesses Tyk's Admin (control-plane) API. This does not cover the gateway's own data plane: a developer-portal client calls that directly from the browser with their own subscription key (`apps/web/src/components/portal/try-it-console.tsx`), the same way any external API consumer would — no platform credential is ever involved in that call.

**Rationale:**
- Tyk credentials must **never** reach the browser
- Backend can sanitize/transform Tyk responses
- Backend implements circuit breaker, retry logic, rate limiting
- Single point of integration for Tyk API changes

**Consequences:**
- All Tyk operations must go through NestJS
- Tyk response data must be modeled in backend DTOs
- Tyk error messages must be sanitized before reaching frontend

---

### ADR-005: Shared Schema Multi-Tenancy with RLS

**Status:** Accepted

**Decision:** All tenants share the same database schema with Row-Level Security.

**Rationale:**
- Cost-effective (single database instance)
- Easier maintenance and migrations
- RLS provides defense-in-depth for tenant isolation
- Application-level guards + database-level policies = zero-trust data access

**Alternatives considered:**
- Schema-per-tenant — complex migrations per tenant, hard to maintain
- Database-per-tenant — expensive, overkill for small/medium tenants

**Consequences:**
- Every query must include `tenantId` scope
- RLS policies must be tested independently
- Migrations apply to all tenants simultaneously
- Tenant-specific config stored as JSON in `Tenant.config`

---

### ADR-006: Prisma as ORM

**Status:** Accepted

**Decision:** Use Prisma 6 for database access.

**Rationale:**
- Type-safe queries (generates TypeScript types from schema)
- Automatic migrations with history
- Excellent developer experience
- Connection pooling support (PgBouncer compatible)

**Consequences:**
- Raw SQL requires `prisma.$queryRaw` or `prisma.$executeRaw`
- Complex queries may need raw SQL for performance
- Prisma generates large client types (acceptable trade-off)

---

### ADR-007: OpenTelemetry for Observability

**Status:** Accepted

**Decision:** Use OpenTelemetry SDK for traces, metrics, and logs.

**Rationale:**
- Vendor-neutral standard (CNCF project)
- Single SDK for all three observability pillars
- Export to any backend (Prometheus, Grafana, Jaeger, Datadog, etc.)
- Growing ecosystem and industry adoption

**Consequences:**
- Requires OTEL Collector in infrastructure
- Adds small performance overhead (~2-5% latency)
- Must instrument NestJS, Next.js SSR, Prisma, Redis, and HTTP clients

---

### ADR-008: JWT in httpOnly Cookies (Not localStorage)

**Status:** Accepted

**Decision:** Store JWT tokens in httpOnly, secure, SameSite=Strict cookies.

**Rationale:**
- httpOnly prevents XSS token theft
- secure ensures cookies only sent over HTTPS
- SameSite=Strict prevents CSRF
- Browser handles cookie lifecycle automatically

**Consequences:**
- Cross-origin requests require `credentials: 'include'`
- Mobile/native apps cannot use this pattern (need separate strategy)
- Refresh token rotation required for secure session management

---

### ADR-009: Circuit Breaker for Tyk Integration

**Status:** Accepted

**Decision:** All Tyk Admin API calls are wrapped in a circuit breaker pattern.

**Rationale:**
- Tyk Admin API may be slow or unavailable
- Without circuit breaker, cascading failures can bring down NestJS
- Fast-fail after threshold prevents resource exhaustion
- Allows graceful degradation (show stale data, queue sync operations)

**Consequences:**
- Circuit breaker state (closed/open/half-open) tracked per service
- `CircuitBreakerService.execute('tyk', ...)` wraps every Tyk Admin API call inside `TykClientService.request()`
- Open circuit throws `CircuitBreakerOpenError` immediately
