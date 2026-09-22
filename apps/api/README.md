# Open Gateway API

> NestJS 11 backend server for the Open Gateway SaaS Admin Dashboard

## Overview

The API server is a NestJS 11 application that serves as the backend for the Open Gateway admin dashboard. It manages API definitions, API keys, tenants, quotas, and analytics — syncing all resources to a Tyk OSS Gateway instance.

**Port:** 33001 (default) (default)
**Base path:** `/api` (global prefix)
**Health check:** `GET /api/health`

---

## Module Structure

The API consists of **8 feature modules** and shared infrastructure:

```
src/
├── main.ts                        # Bootstrap: NestFactory, pipes, CORS, Helmet
├── app.module.ts                  # Root module (imports all feature modules)
├── app.controller.ts              # GET /, GET /health
├── app.service.ts                 # Health check service
│
├── modules/
│   ├── auth/                      # Authentication & authorization
│   │   ├── auth.module.ts
│   │   ├── controllers/
│   │   │   └── auth.controller.ts    # POST /auth/login, /register, /refresh, /logout; GET /auth/me
│   │   ├── services/
│   │   │   └── auth.service.ts       # Login, register, JWT generation, refresh
│   │   ├── strategies/
│   │   │   └── jwt.strategy.ts       # Passport JWT validation
│   │   ├── dto/
│   │   │   ├── login.dto.ts          # Email + password validation
│   │   │   └── register.dto.ts       # Registration validation
│   │   └── types/
│   │       └── auth.types.ts         # JWT payload interface
│   │
│   ├── tenants/                   # Multi-tenant management
│   │   ├── tenants.module.ts
│   │   ├── controllers/
│   │   │   └── tenants.controller.ts   # CRUD /tenants
│   │   └── services/
│   │       └── tenants.service.ts      # Tenant CRUD, user mapping
│   │
│   ├── api-management/            # API definition lifecycle
│   │   ├── api-management.module.ts
│   │   ├── controllers/
│   │   │   └── api-management.controller.ts  # CRUD /apis + sync
│   │   ├── services/
│   │   │   └── api-management.service.ts     # API CRUD + Tyk sync orchestration
│   │   └── dto/
│   │       └── create-api.dto.ts             # API definition validation
│   │
│   ├── tyk-integration/           # Tyk Admin API client
│   │   ├── tyk-integration.module.ts
│   │   └── services/
│   │       └── tyk-client.service.ts    # Direct Tyk API calls (circuit breaker protected)
│   │
│   ├── keys/                      # API key management
│   │   ├── keys.module.ts
│   │   ├── controllers/
│   │   │   └── keys.controller.ts      # CRUD /keys
│   │   └── services/
│   │       └── keys.service.ts         # Key creation, revocation, Tyk sync
│   │
│   ├── quotas/                    # Per-key usage limits
│   │   ├── quotas.module.ts
│   │   ├── controllers/
│   │   │   └── quotas.controller.ts    # CRUD /quotas
│   │   └── services/
│   │       └── quotas.service.ts       # Quota CRUD, reset logic
│   │
│   ├── analytics/                 # Usage metrics
│   │   ├── analytics.module.ts
│   │   ├── controllers/
│   │   │   └── analytics.controller.ts  # GET /analytics/*
│   │   └── services/
│   │       └── analytics.service.ts     # Metrics aggregation, time-series
│   │
│   └── audit/                     # Audit logging
│       ├── audit.module.ts
│       ├── controllers/
│       │   └── audit.controller.ts      # GET /audit-logs
│       └── services/
│           └── audit.service.ts         # Append-only log entries
│
└── common/                        # Shared infrastructure
    ├── circuit-breaker/           # Circuit breaker pattern, wraps TykClientService's requests
    ├── decorators/                # Custom decorators (@CurrentTenant, etc.)
    ├── filters/
    │   └── all-exceptions.filter.ts    # Unified error response format
    ├── guards/                    # JwtAuthGuard, TenantGuard, RolesGuard
    ├── interceptors/              # AuditInterceptor, LoggingInterceptor
    ├── middleware/                # CorrelationIdMiddleware
    ├── redis/                     # Redis client module
    ├── types/                     # Shared TypeScript types
    └── common.module.ts
```

---

## How to Run

### Development

```bash
# From project root
pnpm --filter @open-gateway/api dev

# Or from apps/api directory
cd apps/api && pnpm dev
```

The server starts on `http://localhost:33001` with hot-reload enabled.

### Production

```bash
# Build
pnpm --filter @open-gateway/api build

# Start
pnpm --filter @open-gateway/api start
```

### Docker

```bash
# Build image
docker build -f apps/api/Dockerfile -t open-gateway-api:latest .

# Run
docker run -p 33001:4000 \
  --env-file apps/api/.env.local \
  open-gateway-api:latest
```

---

## How to Add a Module

1. **Generate the module:**
   ```bash
   cd apps/api
   nest generate module modules/feature-name
   nest generate controller modules/feature-name
   nest generate service modules/feature-name
   ```

2. **Create DTOs** in `modules/feature-name/dto/`:
   ```typescript
   import { IsString, IsOptional } from 'class-validator';

   export class CreateFeatureDto {
     @IsString()
     name: string;

     @IsOptional()
     @IsString()
     description?: string;
   }
   ```

3. **Implement the service** with Prisma:
   ```typescript
   import { Injectable } from '@nestjs/common';
   import { PrismaService } from '../../common/prisma/prisma.service';

   @Injectable()
   export class FeatureService {
     constructor(private readonly prisma: PrismaService) {}

     async create(dto: CreateFeatureDto, tenantId: string) {
       return this.prisma.feature.create({
         data: { ...dto, tenantId },
       });
     }

     async findAll(tenantId: string, page = 1, pageSize = 20) {
       const skip = (page - 1) * pageSize;
       const [data, total] = await Promise.all([
         this.prisma.feature.findMany({
           where: { tenantId },
           orderBy: { createdAt: 'desc' },
           skip,
           take: pageSize,
         }),
         this.prisma.feature.count({ where: { tenantId } }),
       ]);
       return { data, total, page, pageSize };
     }
   }
   ```

4. **Implement the controller** with guards:
   ```typescript
   import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
   import { FeatureService } from './feature.service';
   import { CreateFeatureDto } from './dto/create-feature.dto';
   import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';

   @Controller('features')
   @UseGuards(JwtAuthGuard)
   export class FeatureController {
     constructor(private readonly service: FeatureService) {}

     @Post()
     create(@Body() dto: CreateFeatureDto) {
       return this.service.create(dto, 'tenantId');
     }

     @Get()
     findAll(@Query('page') page = '1', @Query('pageSize') pageSize = '20') {
       return this.service.findAll('tenantId', +page, +pageSize);
     }
   }
   ```

5. **Import in AppModule:**
   ```typescript
   // src/app.module.ts
   import { FeatureModule } from './modules/feature/feature.module';

   @Module({
     imports: [
       // ...existing
       FeatureModule,
     ],
   })
   ```

6. **Add database model** (if needed) to `packages/database/prisma/schema.prisma`, then run `pnpm db:migrate:dev --name add_feature` and `pnpm db:generate`.

---

## API Endpoints Reference

All endpoints are prefixed with `/api`.

### Health

| Method | Path | Description | Auth Required |
|--------|------|-------------|:-------------:|
| `GET` | `/` | Root health check | No |
| `GET` | `/health` | Detailed health check | No |

### Authentication

| Method | Path | Description | Auth Required |
|--------|------|-------------|:-------------:|
| `POST` | `/auth/login` | Authenticate with email/password, returns JWT cookies | No |
| `POST` | `/auth/register` | Register a new user account | No |
| `POST` | `/auth/refresh` | Refresh access token using refresh token cookie | No |
| `POST` | `/auth/logout` | Invalidate session, clear cookies | Yes |
| `GET` | `/auth/me` | Get current authenticated user profile | Yes |

### Tenants

| Method | Path | Description | Auth Required |
|--------|------|-------------|:-------------:|
| `GET` | `/tenants` | List tenants (paginated) | Yes |
| `GET` | `/tenants/:id` | Get tenant details | Yes |
| `POST` | `/tenants` | Create new tenant | Yes |
| `PATCH` | `/tenants/:id` | Update tenant | Yes |
| `DELETE` | `/tenants/:id` | Delete tenant | Yes |

### API Definitions

| Method | Path | Description | Auth Required |
|--------|------|-------------|:-------------:|
| `GET` | `/apis` | List API definitions (paginated, filterable by status) | Yes |
| `GET` | `/apis/:id` | Get API definition details | Yes |
| `POST` | `/apis` | Create API definition and sync to Tyk | Yes |
| `PATCH` | `/apis/:id` | Update API definition (or set `status`) and sync to Tyk | Yes |
| `DELETE` | `/apis/:id` | **Delete** the definition (hard delete) and remove it from Tyk. `409` while ACTIVE keys reference it; `502` if the gateway copy cannot be removed (the row is kept) | Yes |
| `POST` | `/apis/:id/sync` | Re-push the definition to the gateway now; returns the resulting `syncStatus` / `syncError` | Yes |

`POST`/`PATCH /apis` answer `409` on a duplicate `slug` within the tenant or on a `listenPath` already
registered by **any** tenant (globally unique), and `400` when `proxyUrl` names a denylisted host.

### Gateway

| Method | Path | Description | Auth Required |
|--------|------|-------------|:-------------:|
| `GET` | `/gateway/status` | Gateway reachability, version, Redis state, probe latency, circuit-breaker state | Yes |

### API Keys

| Method | Path | Description | Auth Required |
|--------|------|-------------|:-------------:|
| `GET` | `/keys` | List API keys (paginated; `page` >= 1, `pageSize` clamped to 1..100) | Yes |
| `GET` | `/keys/:id` | Get key details, including the live gateway limits | Yes |
| `POST` | `/keys` | Create API key in Tyk, hash and store (raw key returned once) | Yes |
| `PATCH` | `/keys/:id` | Update name, expiry, rate limit or quota (`409` unless ACTIVE) | Yes |
| `POST` | `/keys/:id/revoke` | Revoke key (removes it from Tyk) | Yes |
| `GET` | `/keys/:id/usage` | Key usage and quota status | Yes |

### Quotas

No REST surface: quotas are set through `POST`/`PATCH /keys` and enforced by the gateway. `QuotaService`
and the `Quota` model are vestigial local bookkeeping, plus a nightly reset scheduler.

### Analytics

| Method | Path | Description | Auth Required |
|--------|------|-------------|:-------------:|
| `GET` | `/analytics/overview` | Overview metrics (requests, latency, error rate) | Yes |
| `GET` | `/analytics/timeseries?metric=requests&range=7d` | Time-series data | Yes |
| `GET` | `/analytics/apis?range=7d` | Per-API usage statistics | Yes |
| `GET` | `/analytics/keys?range=7d` | Per-key usage statistics | Yes |
| `GET` | `/analytics/top-apis?range=7d` | Busiest APIs over the range | Yes |
| `GET` | `/analytics/status-codes?range=7d` | Response-code breakdown | Yes |
| `GET` | `/analytics/health` | Pipeline health (gateway analytics + pump reachability) | Yes |

### Audit Logs

| Method | Path | Description | Auth Required |
|--------|------|-------------|:-------------:|
| `GET` | `/audit-logs` | List audit entries (paginated, filterable by action/resource) | Yes |
| `GET` | `/audit-logs/stats` | Aggregated counts per action / resource | Yes |
| `GET` | `/audit-logs/export/csv` | Download the filtered entries as CSV | Yes |
| `GET` | `/audit-logs/:id` | Get a single audit entry | Yes |

### Response Format

**Success (200):**
```json
{
  "data": { ... },
  "total": 42,
  "page": 1,
  "pageSize": 20
}
```

**Error (4xx/5xx):**
```json
{
  "statusCode": 400,
  "message": "Validation failed",
  "error": "Bad Request"
}
```

**Validation Error (400):**
```json
{
  "statusCode": 400,
  "message": [
    "name must be a string",
    "proxyUrl must be a valid URL"
  ],
  "error": "Bad Request"
}
```

---

## Environment Variables

| Variable | Required | Default | Description |
|----------|:--------:|---------|-------------|
| `NODE_ENV` | No | `development` | Runtime environment (`development`, `production`, `test`) |
| `PORT` | No | `33001` | HTTP server port |
| `DATABASE_URL` | **Yes** | - | PostgreSQL connection string |
| `REDIS_URL` | **Yes** | - | Redis connection string |
| `JWT_SECRET` | **Yes** | - | JWT signing secret, min 32 random chars (`openssl rand -hex 32`). No default anywhere: compose requires it via `infra/.env`, and startup rejects placeholder / short values |
| `JWT_EXPIRES_IN` | No | `15m` | Access token TTL |
| `JWT_REFRESH_EXPIRES_IN` | No | `7d` | Refresh token TTL |
| `CORS_ORIGINS` | No | `http://localhost:33000` | Comma-separated allowed origins |
| `TYK_ADMIN_URL` | **Yes** | - | Tyk Gateway REST API base URL: `<gateway>/tyk` on the control port (`http://tyk-gateway:8081/tyk` in compose; not published to the host). Open-source gateway only, no Tyk Dashboard |
| `TYK_ADMIN_SECRET` | **Yes** | - | Gateway secret (`TYK_GW_SECRET`), sent as `x-tyk-authorization` |
| `TYK_GATEWAY_URL` | No | - | Base URL for the `/hello` health probe. With a control port set, `/hello` moves there too: `http://tyk-gateway:8081` |
| `TYK_ORG_ID` | No | - | Tyk Organization ID |
| `PROXY_DENY_HOSTS` | No | - | Extra upstream hosts `proxyUrl` may never use (comma separated), on top of the built-in loopback / link-local / metadata / platform-service denylist |
| `PUMP_HEALTH_URL` | No | - | Tyk Pump liveness probe (`http://tyk-pump:8083/health` in compose; the port is not published, so an API on the host cannot reach it) |
| `ANALYTICS_RETENTION_DAYS` | No | `30` | Daily trim of the pump's raw table |
| `ANALYTICS_AGGREGATE_RETENTION_DAYS` | No | `365` | Daily trim of the pump's hourly aggregate table |

See `.env.example` for the complete template.

---

## Testing

```bash
# Run all tests
pnpm test

# Watch mode
pnpm test:watch

# With coverage
pnpm test -- --coverage

# Single test file
pnpm test -- auth.service.spec.ts
```

### Test File Conventions

- Unit tests: `*.service.spec.ts`, `*.controller.spec.ts`
- Integration tests: `*.integration.spec.ts`
- E2E tests: `test/app.e2e-spec.ts`

### Running Tests for a Specific Module

```bash
pnpm test -- tenants
```

---

## Security Notes

- **Tyk credentials are NEVER exposed to the frontend.** All Tyk calls go through `TykClientService`, which sanitizes responses.
- **Global validation pipe** strips unexpected properties (`forbidNonWhitelisted: true`).
- **Helmet** is enabled globally for security headers.
- **Rate limiting** is configured (100 req/min in production, 1000 in development).
- **Circuit breaker** (`CircuitBreakerService`) wraps every Tyk Admin API call inside `TykClientService.request()`.

For the complete security architecture, see [docs/security.md](../../docs/security.md).
