# Security Documentation

> Security architecture, threat model, and hardening procedures for Open Gateway

## ⚠️ Implementation status — read this first

Most of this document describes the **target** architecture. Sections and bullets that are not
implemented are marked **PLANNED**; everything else describes code that exists. The short version of
what the current build actually enforces:

| Control | State | Where |
|---------|-------|-------|
| Access tokens issued by **Ory Hydra** (OAuth2/OIDC); this app verifies them against Hydra's JWKS (RS256) and signs nothing itself | Implemented | `JwtStrategy`, `common/ory/jwks.ts` |
| Login, registration, recovery and verification are **Ory Kratos** self-service flows; the only surviving local route is `GET /auth/me` | Implemented | `AuthController`, `infra/ory/kratos/` |
| Roles, permissions and active tenant resolved from Postgres + **Ory Keto** on every request — the token carries none of them, so a suspended user or a revoked membership takes effect on the very next request, not at token expiry | Implemented | `AuthService#resolveSession`, `common/ory/keto.ts` |
| Tenant scoping: `X-Tenant-ID` must match the session's resolved tenant, a session with none is refused, every query filters on `tenantId` | Implemented | `TenantIsolationGuard`, services |
| `super_admin` cannot be handed out through `POST /tenants/:id/users` — closes a tenant-scoped path to the installation-wide bypass | Implemented | `tenants/dto/assign-user.dto.ts` (`ASSIGNABLE_ROLES`) |
| Upstream (`proxyUrl`) denylist: loopback, link-local / cloud-metadata, platform service names, `PROXY_DENY_HOSTS` | Implemented | `api-management/dto/proxy-url.validator.ts` |
| Globally unique listen paths (one tenant cannot claim another's route) | Implemented | `ApiDefinition.@@unique([listenPath])`, `ApiService` |
| Gateway control API (`/tyk/*`, `/hello`) on an unpublished port | Implemented | `TYK_GW_CONTROLAPIPORT: 8081`, no host mapping |
| Postgres / Redis published on `127.0.0.1` only | Implemented | `infra/docker-compose.yml` |
| API keys stored as SHA-256 hashes, raw key shown once | Implemented | `KeyService` |
| Append-only audit log | Implemented | `AuditLogInterceptor` |
| PostgreSQL Row-Level Security policies | **PLANNED — not implemented** | no migration creates any policy |
| Vault / KMS secret storage, field-level encryption, mTLS, NetworkPolicies | **PLANNED — not implemented** | secrets come from env files (`infra/.env`, `apps/api/.env.local`, chmod 600) |
| Kratos recovery/verification emails actually reaching a mailbox | Implemented (WP22) | Mailpit (`infra/docker-compose.yml`) is the default `COURIER_SMTP_CONNECTION_URI`, and `kratos` now runs with `--watch-courier` — without that flag a flow answers `sent_email` but the courier's dispatch loop never runs, live-verified while wiring this. Set `KRATOS_SMTP_URI` to point at a real external SMTP server for an install that needs mail to leave the stack |
| Self-service developer portal, separate from the dashboard's Hydra-JWT session: Kratos session (`X-Session-Token`/cookie) via `/sessions/whoami`, never a Hydra JWT | Implemented (WP22) | `modules/portal/`, `DeveloperAuthGuard`, `common/ory/kratos.ts` |
| Webhook receiver URLs reuse the `proxyUrl` denylist above — no second SSRF check | Implemented (WP27) | `webhooks/dto/create-webhook-subscription.dto.ts` |
| Webhook relay (`POST /webhooks/relay/:apiId`, `@Public()` — Tyk's own event handler calls it, carrying no dashboard session): a shared secret Tyk's config embeds as a header, checked with a constant-time compare, `TYK_WEBHOOK_RELAY_SECRET` with no default. The endpoint is served by this same process, so it is reachable through the edge's published API port too, not only from Tyk in-network — the secret is what stops an outside caller from forging a Tyk event, not network placement | Implemented (WP27) | `webhooks/controllers/webhook-relay.controller.ts` |
| The live Tyk key in a webhook's default payload is redacted before the signed, forwarded copy ever reaches a tenant's `receiverUrl` | Implemented (WP27) | `webhooks/services/webhook-relay.service.ts` |
| Captured request/response traffic (`detailedRecording`): tenant-scoped `apiDefId` → `tykApiId` resolution server-side only, gated on `api:update`/`analytics:read`; a second, name-pattern redaction pass on top of the Postgres trigger (headers, query/form params, JSON fields); the traffic view fails closed (`FAILED`, never `OK`) if the redaction trigger is missing or disabled | Implemented (v1) | `analytics/services/traffic-inspector.service.ts`, `http-dump-parser.ts`, `pump-query.builder.ts` |
| Invite-by-email (`POST :id/users/invite`) ships **disabled by default** behind `FEATURE_INVITE_BY_EMAIL` — the route isn't registered when unset, a real 404 before any guard runs, not an in-handler check. Security review found an attacker who pre-registers the invitee's email can take over the pending row once the real owner verifies or recovers that identity, because `kratos.yml` has no session-revocation hooks on recovery/settings and no verified-address requirement on login. Turning it on needs those two `kratos.yml` hooks plus an "identity created after the invite" ordering check | **Implemented, held back pending the above** | `tenants/controllers/tenant.controller.ts`, `infra/ory/kratos/kratos.yml` |

**Dead but deliberately kept (WP7 decision, not deleted this pass):** `modules/auth/services/token.service.ts`, `modules/auth/jwt-secret.ts`, `modules/auth/dto/login.dto.ts`, `modules/auth/dto/register.dto.ts`, `modules/auth/types/auth.types.ts` and their `.spec.ts` files each carry a `DEPRECATED —` header and have no live caller. `JWT_SECRET`, `JWT_EXPIRES_IN` and `JWT_REFRESH_EXPIRES_IN` likewise still appear in `infra/docker-compose.yml` / `install.sh` / `.env.example` with no reader in the API. `COOKIE_SECURE` is *not* dead — it moved: `apps/web` now reads it to flag its own session cookies `Secure`, the API no longer does. `TRUST_PROXY_HOPS` is unrelated to this migration and still works as before (Express `trust proxy` hop count for rate limiting).

Known limits of what *is* implemented: the `proxyUrl` denylist is a denylist, not SSRF protection —
DNS rebinding and public names that resolve to private addresses are out of scope. The dev compose
file keeps a well-known default for `TYK_GW_SECRET`; that is only acceptable because the control API
is not published, and it must be set for any shared or exposed deployment.

## Table of Contents

1. [Security Architecture](#security-architecture)
2. [Tyk Credential Isolation](#tyk-credential-isolation-critical)
3. [JWT Security](#jwt-security)
4. [Password Policy](#password-policy)
5. [Rate Limiting](#rate-limiting)
6. [Input Validation](#input-validation)
7. [Tenant Isolation Enforcement](#tenant-isolation-enforcement)
8. [Audit Logging](#audit-logging)
9. [Dependency Security](#dependency-security)
10. [Vulnerability Reporting](#vulnerability-reporting)

---

## Security Architecture

Open Gateway **targets** defense in depth with 5 independent security layers. The diagram below is the
target design, not an inventory of the current build: network policies, mTLS, RLS, Vault-backed
secrets and asymmetric JWT signing are **PLANNED**. See [Implementation status](#️-implementation-status--read-this-first).

```
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 1: Network Isolation                                        │
│  ──────────────────────────                                        │
│  • Private subnets for PostgreSQL, Redis, Tyk Admin                │
│  • No public pod IPs — all traffic through services/ingress        │
│  • Deny-all Kubernetes NetworkPolicy by default                    │
│  • mTLS between services (production, via Istio/Linkerd)          │
│  • Tyk Admin API only reachable from NestJS pod CIDR               │
│  • No egress to internet from database/cache pods                  │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 2: Authentication & Authorization — IMPLEMENTED (Ory stack)   │
│  ──────────────────────────────────────                             │
│  • Ory Hydra issues OAuth2/OIDC access tokens (RS256, JWKS-verified) │
│  • Ory Kratos owns login/register/recovery/verification              │
│  • Ory Keto + Postgres resolve tenant/role/permission per request   │
│  • httpOnly + SameSite=Lax cookies, Secure in prod (XSS resistant)  │
│  • RBAC: super_admin, admin, operator, viewer                       │
│  • ABAC: tenant ownership enforced on every data query             │
│  • Revoked membership takes effect on the next request, not at TTL │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 3: Data Protection                                          │
│  ─────────────────────                                             │
│  • TLS 1.3 on all connections (browser → Next.js → NestJS → DB)   │
│  • AES-256 at rest (encrypted disk volumes)                        │
│  • Field-level encryption for secrets (Vault Transit API)          │
│  • PostgreSQL Row-Level Security (RLS) on all multi-tenant tables  │
│  • Prisma parameterized queries (SQL injection impossible)         │
│  • Argon2id password hashing (Ory Kratos, not this app)            │
│  • API key hashes (SHA-256) stored — raw keys never persisted      │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 4: Application Security                                     │
│  ─────────────────────────────                                     │
│  • class-validator DTOs on ALL NestJS endpoints                    │
│  • Whitelist validation (forbidNonWhitelisted: true)               │
│  • Zod schema validation on all frontend inputs                    │
│  • Helmet security headers on NestJS                               │
│  • CSP headers configured (no inline scripts)                      │
│  • CORS whitelist (only configured origins allowed)                │
│  • Global rate limiting (100 req/min in production)                │
│  • Per-endpoint rate limiting (auth: 5 req/min)                    │
│  • Circuit breakers on all Tyk API calls                           │
│  • React auto-escaping prevents XSS                                │
│  • No dangerouslySetInnerHTML without DOMPurify sanitization       │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│  Layer 5: Supply Chain Security                                    │
│  ────────────────────────────────                                  │
│  • Dependabot: weekly dependency update PRs                       │
│  • npm audit: CI blocks on critical vulnerabilities               │
│  • Trivy: container image scanning in CI pipeline                 │
│  • Syft: SBOM generation for every container image                │
│  • Cosign: signed container images                                │
│  • .npmrc: shamefully-hoist=false (no phantom dependencies)        │
│  • pnpm lockfile committed (deterministic installs)               │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Tyk Credential Isolation (CRITICAL)

**This is the most critical security requirement in Open Gateway.** Tyk Admin credentials must **NEVER** be exposed to the frontend or logged.

### Threat Model

| Threat | Impact | Mitigation |
|--------|--------|------------|
| Tyk Admin key leaked to browser | Attacker gains full control of Tyk Gateway — can create/modify/delete all API definitions and keys | **Key stored ONLY in NestJS env var, never sent to frontend** |
| Tyk Admin key in logs | Attacker with log access extracts key | **NEVER logged — only domain errors from sanitized responses** |
| Tyk Admin key in error messages | Attacker sees key in API error response | **All Tyk errors sanitized — only "Tyk integration error: {message}" returned** |
| Tyk Admin key in source code | Anyone with repo access has key | **Read from an env var only.** Today it comes from `infra/.env` / `apps/api/.env.local` (git-ignored, chmod 600), generated by `install.sh`. Vault / K8s-Secret injection is **PLANNED**. The dev compose file still falls back to a well-known `TYK_GW_SECRET` default, which is tolerable only because the control API is not published — set it for any shared deployment |

### Implementation

**1. Storage — Environment Variable Only**

```typescript
// TykClientService constructor
constructor(private readonly configService: ConfigService) {
  this.adminApiUrl = this.configService.get<string>('TYK_ADMIN_URL', '');
  this.adminKey = this.configService.get<string>('TYK_ADMIN_SECRET', '');
  // Key is read from env var at runtime only
  // NEVER written to any file, database, or response
}
```

**2. Request — Header Only, Never in Body**

```typescript
// The admin key is sent ONLY as a Tyk-specific auth header
private async request(path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-tyk-authorization': this.adminKey,  // ← Header only
      ...options.headers,
    },
  });
  // Key is NEVER in the request body
  // Key is NEVER in the response
}
```

**3. Response — Sanitized Before Return**

```typescript
sanitizeResponse(response: Record<string, unknown>): Record<string, unknown> {
  const sanitized = { ...response };

  // Remove ALL Tyk internal fields
  delete sanitized.internal_id;
  delete sanitized.hook_references;
  delete sanitized.org_id;
  delete sanitized._id;

  return sanitized;
}
```

**4. Error Handling — Domain Errors Only**

```typescript
if (!response.ok) {
  // Map Tyk error to domain error — NEVER expose Tyk internals
  const message = typeof data.Message === 'string'
    ? data.Message
    : 'Tyk API request failed';

  this.logger.error(`Tyk API error: ${message}`);  // ← Only message, never full response
  throw new BadRequestException(`Tyk integration error: ${message}`);
}
```

**5. Frontend — Zero Knowledge**

The Next.js frontend has **no environment variables** for Tyk. The `NEXT_PUBLIC_*` prefix is **never** used for Tyk configuration.

| Environment Variable | Frontend Access | Backend Access |
|---------------------|-----------------|----------------|
| `TYK_ADMIN_URL` | ❌ No | ✅ Yes |
| `TYK_ADMIN_SECRET` | ❌ No | ✅ Yes |
| `TYK_ORG_ID` | ❌ No | ✅ Yes |

**6. Audit Trail**

Every Tyk operation is logged in the audit log:

| Action | Logged When |
|--------|-------------|
| `SYNC_SUCCEEDED` | API successfully created/updated in Tyk |
| `SYNC_FAILED` | Tyk API call failed (error message sanitized) |

---

## JWT Security

This app signs nothing. Access tokens are minted by **Ory Hydra** and verified here against Hydra's
JWKS — there is no `JWT_SECRET` anywhere in this path (the env var by that name is a leftover; see
[Implementation status](#️-implementation-status--read-this-first)).

### Token Verification

`apps/api/src/modules/auth/strategies/jwt.strategy.ts` accepts the token from the `access_token`
httpOnly cookie or, for machine callers, an `Authorization: Bearer` header, then checks:

| Check | Value | Note |
|-------|-------|------|
| Algorithm | `RS256` only | No symmetric algorithm is accepted |
| Signature | Hydra's rotating public key | Fetched from `<ORY_HYDRA_PUBLIC_URL>/.well-known/jwks.json`, keyed by the token's `kid` |
| `iss` | Must equal `ORY_HYDRA_ISSUER` (e.g. `https://localhost:33010/`) | The browser-facing URL Hydra stamps into every token — **not** the in-network `http://hydra:4444` the JWKS itself is fetched from |
| `exp` | Enforced | `ignoreExpiration: false` |
| `aud` | **Not checked, deliberately** | Hydra issues `aud: []` unless a client requests one (verified on v26.2.0); checking it would reject every token the dashboard holds. WP4's data-plane tokens are validated by Tyk, not by this API |

Only `sub` is read out of the payload — no email, roles, tenant or permission claims exist on the
token (Hydra's token hook is off; see `infra/ory/hydra/hydra.yml`). A token whose `sub` is not a local
`User.id` (e.g. a `client_credentials` token meant for the Tyk data plane) resolves to no session and
401s, rather than to a half-populated one.

### Session Resolution (Postgres + Ory Keto) — why it's split this way

Because the token carries no tenant/role/permission claims, `AuthService#resolveSession` rebuilds the
session from scratch on **every request**:

1. **Ory Keto answers "is this subject a member of this tenant at all"** — a `check` against the
   `Tenant` namespace's `member`/`admin` relations (`common/ory/keto.ts`, model in
   `infra/ory/keto/namespaces.ts`). A membership with no tuple is denied even if the Postgres row says
   otherwise.
2. **Postgres answers "which of the 27 permission names does their role in that tenant grant"** — the
   `UserTenant.role` → `Role` → `RolePermission` → `Permission` chain (`AuthService#loadPermissions`,
   `common/guards/permissions.guard.ts`).

The two are split because they answer different questions at different trust levels: Keto is the
single source of truth for *whether you belong*, cheap to check on a hot path and easy to reason about
as a Zanzibar-style relation graph; Postgres keeps the *fine-grained* role-to-permission mapping this
project already had, without needing to model all 27 permission names in Keto yet (see the "WP2
extends it" comment in `infra/ory/keto/namespaces.ts`). The practical consequence: **a suspended user
or a revoked/demoted membership takes effect on the very next request**, not at the end of a token's
TTL — there is no session cache to invalidate, because there is no cached session.

### Token Lifetimes

Configured on the Hydra side (`infra/ory/hydra/hydra.yml`'s `ttl`), not by this app:

| Token | TTL | Storage | Rotation |
|-------|-----|---------|----------|
| **Access Token** | 1 hour | httpOnly, `SameSite=Lax` cookie, set by `apps/web` after the Hydra token exchange (not by this API) | Not applicable — re-fetched via `apps/web`'s `/oauth2/refresh` route once expired |
| **Refresh Token** | 720 hours (30 days) | Same cookie jar | Handled by Hydra's OAuth2 refresh grant; this app has no refresh endpoint and does not track or rotate refresh tokens itself |

### Cookie Security Properties

| Property | Value | Rationale |
|----------|-------|-----------|
| `httpOnly` | `true` | JavaScript cannot read the cookie (XSS protection) |
| `secure` | `true` in production (`COOKIE_SECURE` can override) | Set by `apps/web`, which now owns this flag — the API no longer sets any auth cookie |
| `sameSite` | `Lax` | Cookie withheld from cross-site *subrequests* (CSRF protection); still sent on a top-level navigation, which `Strict` would also block |
| `path` | `/` | `apps/web`'s PKCE/state cookie (`oauth2_flow`) is scoped tighter, to `/oauth2` |

### Attack Mitigations

| Attack | Mitigation |
|--------|-----------|
| **Token theft (XSS)** | httpOnly cookie prevents JavaScript access |
| **Token theft (network)** | TLS + `Secure` flag (in production) |
| **CSRF** | `SameSite=Lax` + CORS whitelist |
| **Token forgery** | RS256 signature verified against Hydra's JWKS — no shared secret exists to leak or brute-force |
| **Revoked / suspended account still working** | Resolved per request from Postgres + Keto (see above), not baked into the token |
| **Tenant-scoped privilege escalation to `super_admin`** | `POST /tenants/:id/users` can no longer assign it (`tenants/dto/assign-user.dto.ts`) |

---

## Password Policy

**Ory Kratos owns this now.** There is no `POST /auth/register` or password-reset endpoint left in
this API (`modules/auth/dto/register.dto.ts`, which used to encode the rules below, is dead — see
[Implementation status](#️-implementation-status--read-this-first)); registration, login and recovery
are Kratos self-service flows, fronted by the pages under `apps/web/src/app/(auth)/auth/`.

### Hashing Algorithm

| Property | Value | Where |
|----------|-------|-------|
| Algorithm | Argon2id | `infra/ory/kratos/kratos.yml`'s `hashers.algorithm` |
| Parameters | 128 MB memory, 3 iterations, parallelism 4, 16-byte salt, 32-byte key | Same file, `hashers.argon2` |
| Legacy bcrypt hashes | Still verify | Kratos picks the verifier from the stored hash's own prefix, so a bcrypt `$2b$12$…` hash imported by `packages/database/scripts/migrate-users-to-kratos.ts` authenticates without a reset (verified on v26.2.0) |
| Storage | Kratos's own identity credentials store, not the `users.password` column | The Postgres `password` column still exists and is still bcrypt-hashed by `prisma/seed.ts`, but nothing in the live login path reads it any more |

### Password Requirements

`infra/ory/kratos/kratos.yml` does not override `selfservice.methods.password.config`, and
`identity.schema.json` encodes no complexity rule (it only shapes `traits`, i.e. email/name) — so
**Kratos's built-in default policy applies**, not a policy this project defines: a minimum length
(Kratos's documented default is 8) and a check against the HaveIBeenPwned breached-password database
(`haveibeenpwned_enabled`, on by default). This repo does not raise the minimum length, add a
character-class rule, or disable the breach check — if that is wanted, it is a `password.config`
addition to `kratos.yml`, not application code.

### Password Recovery

Kratos's `code`-based recovery flow is enabled (`selfservice.flows.recovery`), fronted by
`apps/web/src/app/(auth)/auth/recovery/page.tsx`. One real gap: `kratos.yml`'s `courier.smtp` is a
placeholder (`smtps://placeholder:placeholder@localhost:1025/…`) and no mail server runs in this
stack, so a recovery code has nowhere to be delivered unless `KRATOS_SMTP_URI` is set to a real SMTP
endpoint, or an operator mints a recovery link directly via Kratos's admin API
(`POST /admin/recovery/link`) — see the `courier` comment in `kratos.yml`. This is marked **PLANNED,
NOT IMPLEMENTED** in the status table above for that reason.

---

## Rate Limiting

### Global Rate Limiting

Configured via `@nestjs/throttler`:

```typescript
ThrottlerModule.forRoot([{
  ttl: 60000,     // 60 second window
  limit: process.env.NODE_ENV === 'production' ? 100 : 1000,
}])
```

| Environment | Limit | Window |
|-------------|-------|--------|
| Development | 1000 requests | 60 seconds |
| Production | 100 requests | 60 seconds |

### Per-Endpoint Rate Limits

`POST /auth/login`, `/auth/register` and `/auth/refresh` do not exist any more (Kratos and Hydra own
those flows outside this app), and the surviving `GET /auth/me` has no route-specific limit either —
it gets the single global bucket. WP22's portal is the first real `@Throttle()` consumer, on its two
abusable, unauthenticated-by-design endpoints (live-verified: a flood of `POST /portal/auth/register`
calls trips 429 within its own limit).

| Endpoint | Limit | Window | Rationale |
|----------|-------|--------|-----------|
| `POST /portal/auth/register` | 5 requests | 60 seconds | Per-IP sign-up abuse control (WP22 acceptance) |
| `POST /portal/applications/:id/subscriptions` | 10 requests | 60 seconds | Per-IP key-issue abuse control (WP22 acceptance) — this is the expensive step, a live Tyk policy + key |
| Everything else | 100 requests (production) / 1000 (development) | 60 seconds | Default global limit — no other per-endpoint override exists |

### Rate Limit Response

```json
{
  "statusCode": 429,
  "message": "ThrottlerException: Too Many Requests",
  "error": "Too Many Requests"
}
```

Header included:
```
Retry-After: 42
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 0
X-RateLimit-Reset: 1712500060
```

### Redis-Based Rate Limiting (Production) — **PLANNED, NOT IMPLEMENTED**

`ThrottlerModule.forRoot` (`app.module.ts`) uses the default in-memory storage; no `ThrottlerStorageRedisService` is registered. Rate limits are per-replica today, not shared across replicas. The intended design:

```typescript
// Production throttler storage uses Redis
{
  storage: new ThrottlerStorageRedisService(redisClient),
}
```

---

## Input Validation

### Backend: class-validator DTOs

Every NestJS endpoint validates input with DTOs:

```typescript
// Example: CreateApiKeyDto
import { IsString, IsOptional, IsDateString, IsUUID } from 'class-validator';

export class CreateApiKeyDto {
  @IsString()
  @MinLength(1)
  @MaxLength(255)
  name: string;

  @IsUUID()
  @IsOptional()
  apiDefId?: string;

  @IsDateString()
  @IsOptional()
  expiresAt?: string;
}
```

**Global Validation Pipe Configuration:**

```typescript
// main.ts
app.useGlobalPipes(
  new ValidationPipe({
    transform: true,                    // Auto-transform plain objects to DTO classes
    whitelist: true,                    // Strip properties not in DTO
    forbidNonWhitelisted: true,         // Reject requests with unexpected properties
    transformOptions: {
      enableImplicitConversion: true,  // Convert strings to numbers/booleans
    },
  }),
);
```

| Validation Rule | Effect |
|----------------|--------|
| `whitelist: true` | Strips properties not defined in DTO |
| `forbidNonWhitelisted: true` | Returns 400 if unexpected properties present |
| `transform: true` | Converts request body to DTO class instance |

### Frontend: Zod Validation

All user inputs validated with Zod before sending to API:

```typescript
import { z } from 'zod';

export const createApiSchema = z.object({
  name: z.string().min(1).max(255),
  slug: z.string().min(1).max(100).regex(/^[a-z0-9-]+$/),
  proxyUrl: z.string().url(),
  listenPath: z.string().min(1).max(255),
  authType: z.enum(['NONE', 'AUTH_TOKEN', 'JWT', 'OAUTH']),
});
```

### Sanitization Summary

| Input Type | Sanitization |
|------------|-------------|
| Strings | Trimmed, HTML escaped (React auto-escaping) |
| URLs | Validated with `z.string().url()` |
| UUIDs | Validated with `@IsUUID()` |
| Email | Validated with `@IsEmail()` |
| JSON config | Validated with Zod schema |
| Tyk responses | Sanitized by `TykClientService.sanitizeResponse()` |

### Upstream URL denylist (`proxyUrl`)

A tenant admin can publish a keyless route, so the upstream URL is a trust boundary: pointed at
`http://169.254.169.254/` or at the platform's own ports, the gateway would happily proxy the answer
back out. `apps/api/src/modules/api-management/dto/proxy-url.validator.ts` refuses, by parsed host:

- loopback and unspecified: `localhost`, `127.0.0.0/8`, `0.0.0.0/8`, `::1`, `::`
- link-local and cloud metadata: `169.254.0.0/16`, `fe80::/10`, `metadata`, `metadata.google.internal`
- **every compose service name**: `postgres`, `redis`, `tyk-gateway`, `tyk-gateway-init`, `tyk-pump`,
  `api`, `web`, `ory-db-init`, `hydra`, `hydra-migrate`, `kratos`, `kratos-migrate`, `keto`, `keto-migrate`
- **every container name**, via the `open-gateway-` prefix — Docker's embedded DNS resolves container
  names as well as compose's service aliases, so `open-gateway-kratos` reaches the same host as `kratos`
- anything listed in `PROXY_DENY_HOSTS` (comma separated)

Because the check runs on the **parsed** host, userinfo (`http://evil@127.0.0.1`) and the decimal / hex /
octal IPv4 and IPv4-mapped IPv6 forms (`http://2130706433`, `http://[::ffff:127.0.0.1]`) are covered.

> **Why the full service list, not just the obvious ones.** Hydra's admin API (4445), Kratos's admin
> API (4434) and Keto's write API (4467) are **unauthenticated by design** — "only reachable inside the
> compose network" is the whole of their protection. An API definition pointing at one of them punches
> straight through it: Kratos admin mints a recovery link for *any* identity, Hydra admin owns every
> OAuth2 client, Keto admin writes tenant membership. Publishing such a route needs only `api:create`
> (the `operator` role, not an admin). This list fell behind the Ory services when they were added, so
> `proxy-url.validator.spec.ts` now parses `infra/docker-compose.yml` and fails CI if any service or
> container name is not denied — a new service cannot silently become a new upstream target.

Deliberately **allowed**: third-party internal service names (`http://orders:8080`), RFC1918 addresses
and unique-local IPv6 — self-hosted upstreams are the product's main use case. The platform's **own**
service names are not among them. This is therefore a denylist, **not** SSRF protection: DNS rebinding
and public names that resolve to private addresses are **out of scope** and would need enforcement at
resolve time in the proxy itself.

---

## Tenant Isolation Enforcement

### Three-Layer Isolation

| Layer | Mechanism | Enforced By | State |
|-------|-----------|-------------|-------|
| **Application** | Prisma queries scoped to `tenantId` | NestJS services | Implemented |
| **HTTP** | `TenantIsolationGuard`: an `X-Tenant-ID` header must equal the session's resolved tenant, and a session with no tenant is refused outright (an unscoped query would otherwise return every tenant's rows) | NestJS guard | Implemented |
| **HTTP** | Re-checking tenant membership on every request | `JwtStrategy` → `AuthService#resolveSession`, ahead of the guard | Implemented — see note below (this changed with the Ory cutover; it used to be PLANNED) |
| **Database** | PostgreSQL Row-Level Security (RLS) | PostgreSQL policies | **PLANNED** — no migration creates a policy |

### Layer 1: Application (Prisma)

Every service method includes `tenantId` in queries:

```typescript
async findAll(tenantId: string, page: number, pageSize: number) {
  return this.prisma.apiDefinition.findMany({
    where: { tenantId },  // ← Every query scoped to tenant
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
}
```

### Layer 2: HTTP Guard

**Implemented:** `TenantIsolationGuard` (`apps/api/src/common/guards/tenant-isolation.guard.ts`) rejects a
request whose `X-Tenant-ID` header disagrees with the session's resolved tenant, rejects a session with
no tenant at all, and otherwise pins `request.tenantId` for `@CurrentTenant` and the audit interceptor.
The guard itself does **not** hit the database — but by the time it runs, the database (and Keto) already
have: `JwtStrategy.validate` calls `AuthService#resolveSession` on every request, which confirms tenant
membership against **Ory Keto** (`ketoCheck`, not the `userTenant` row alone) before the guard ever sees
the request. This is a change from the pre-Ory design this doc used to describe here: membership used to
be resolved once at login and baked into the signed token, so a revoked membership stayed effective until
the token expired; now there is no such window — a revoked or demoted membership is denied on the very
next request, because there is nothing cached to still be valid.

### Layer 3: Database (RLS) — **PLANNED, NOT IMPLEMENTED**

No migration in `packages/database/prisma/migrations/` enables row-level security or creates any policy,
and the API connects as the schema owner, which would bypass RLS anyway unless `FORCE ROW LEVEL SECURITY`
were set. Tenant isolation currently rests on Layer 1 and Layer 2 alone. The policies below are the
intended design:

```sql
-- Enable RLS on multi-tenant tables
ALTER TABLE api_definitions ENABLE ROW LEVEL SECURITY;

-- Policy: users can only see rows for their tenant
CREATE POLICY tenant_isolation_api_definitions
  ON api_definitions
  USING (tenant_id = current_setting('app.current_tenant_id'));

-- Policy: inserts must include current tenant
CREATE POLICY tenant_insert_api_definitions
  ON api_definitions
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id'));
```

### Isolation Test

```typescript
it('should prevent tenant A from seeing tenant B data', async () => {
  const tenantAData = await service.findAll('tenant-a');
  const tenantBData = await service.findAll('tenant-b');

  expect(tenantAData).not.toEqual(tenantBData);
  expect(tenantAData.map(d => d.tenantId)).not.toContain('tenant-b');
  expect(tenantBData.map(d => d.tenantId)).not.toContain('tenant-a');
});
```

---

## Audit Logging

### Append-Only Design

The `AuditLog` model is designed as an **append-only, immutable ledger**:

```prisma
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

  // Note: NO update or delete operations
  // Only INSERT is permitted
}
```

### Audit Actions

```prisma
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
```

### Audit Interceptor

Every NestJS module can use the `AuditInterceptor` to automatically log actions:

```typescript
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const startTime = Date.now();

    return next.handle().pipe(
      tap({
        next: (data) => {
          this.auditService.log({
            tenantId: request.tenantId,
            userId: request.user?.sub,
            action: this.mapAction(context),
            resource: this.mapResource(context),
            details: { method: request.method, url: request.url, duration: Date.now() - startTime },
            ipAddress: request.ip,
            corrId: request.correlationId,
          });
        },
      }),
    );
  }
}
```

### Audit Log Properties

| Property | Description | Example |
|----------|-------------|---------|
| `id` | Auto-increment BigInt (prevents ID guessing) | 1000001 |
| `tenantId` | Which tenant this action relates to | `tenant-abc123` |
| `userId` | Which user performed this action | `user-xyz789` |
| `action` | What happened | `CREATED` |
| `resource` | What was affected | `api_definition` |
| `details` | Additional context (JSON) | `{"name": "My API", "slug": "my-api"}` |
| `ipAddress` | Origin IP of the request | `192.168.1.100` |
| `corrId` | Correlation ID for tracing | `abc-123-def-456` |
| `createdAt` | When it happened | `2024-04-07T10:30:00Z` |

### Compliance

Audit logs satisfy:
- **SOC 2 Type II** — All user actions logged with timestamps
- **ISO 27001** — Immutable audit trail with tamper evidence
- **GDPR Article 30** — Processing records with user identification

### Export

Audit logs are exported weekly to cold storage (S3 Glacier) for long-term retention (2 years).

---

## Dependency Security

### Automated Scanning

| Tool | What It Scans | Frequency | CI Action |
|------|--------------|-----------|-----------|
| **Dependabot** | npm dependencies | Weekly | Opens PR with version bump |
| **npm audit** | Known vulnerabilities in npm packages | Every CI run | Blocks on critical severity |
| **Trivy** | Container image vulnerabilities | Every CI run (build stage) | Blocks on HIGH/CRITICAL |
| **ESLint security rules** | Insecure code patterns | Every CI run | Fails on security rule violation |

### Dependency Policy

1. **No deprecated packages** — Remove or replace any package marked deprecated
2. **No major version lag** — Update within 2 major versions of latest
3. **No peer dependency conflicts** — pnpm enforces strict resolution
4. **Lockfile always committed** — `pnpm-lock.yaml` in version control

### Critical Dependency Inventory

| Dependency | Current Version | Security Notes |
|-----------|-----------------|----------------|
| `@nestjs/core` | 11.x | Latest major — security patches active |
| `bcrypt` | latest | Legacy — live password hashing is Kratos's Argon2id now. Still used by `prisma/seed.ts` and the deprecated `modules/auth/` DTOs/services |
| `passport-jwt` | 4.x | Verifies Hydra-issued RS256 tokens against its JWKS (`JwtStrategy`) — this app signs nothing with it. `@nestjs/jwt`/`jsonwebtoken` remain in `package.json` too but only the deprecated, uninjected `TokenService` still imports `@nestjs/jwt` |
| `helmet` | latest | Security headers — enabled globally |
| `cookie-parser` | latest | Cookie parsing — no known vulnerabilities |
| `class-validator` | latest | Input validation — keep updated |
| `@prisma/client` | 6.x | Generated code — safe |
| `next` | 15.x | Latest major — security patches active |
| `react` | 19.x | Latest major — security patches active |

---

## Vulnerability Reporting

### Responsible Disclosure

If you discover a security vulnerability in Open Gateway:

1. **DO NOT** open a public GitHub issue
2. **DO NOT** disclose the vulnerability publicly
3. **DO** email the security team at `security@open-gateway.example.com` with:
   - Description of the vulnerability
   - Steps to reproduce
   - Potential impact
   - Suggested fix (optional)

### Response Timeline

| Stage | Timeline |
|-------|----------|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 5 business days |
| Fix developed | Within 14 business days (critical: 48 hours) |
| Fix deployed | Within 24 hours of release |
| Public disclosure | After fix is available and affected users notified |

### Severity Classification

| Severity | Definition | Response Time |
|----------|-----------|---------------|
| **Critical** | Remote code execution, data breach, Tyk credential exposure | 48 hours |
| **High** | Authentication bypass, tenant data leakage, privilege escalation | 7 days |
| **Medium** | XSS, CSRF, information disclosure | 14 days |
| **Low** | Minor information leak, missing header | 30 days |

### Security Advisories

Published security advisories will be posted to:
- GitHub Security Advisories page
- Project website security page
- Email notification to registered users (for critical/high severity)
