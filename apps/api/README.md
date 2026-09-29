# MIRQAB API

NestJS 11 backend for the MIRQAB dashboard. It owns all Tyk credentials: it pushes API definitions, policies and keys to the open-source Tyk Gateway, reads analytics that Tyk Pump writes to Postgres, and verifies Ory Hydra access tokens against Hydra's JWKS (it signs nothing itself).

> **Full reference:**
> - [docs/reference/api-identity-and-commerce.md](../../docs/reference/api-identity-and-commerce.md) — auth, tenants, roles, oauth-clients, keys, plans, products, quotas, portal, audit, governance
> - [docs/reference/api-gateway-and-analytics.md](../../docs/reference/api-gateway-and-analytics.md) — api-management, api-import, spec-fetch, tyk-integration, analytics (incl. `GET /analytics/traffic`), certificates, settings, webhooks, mcp, observability, bootstrap and shared guards
>
> Each page lists every endpoint with its permission code. Use those pages, not a hand-kept route table here.

## Run

```bash
pnpm --filter @open-gateway/api dev          # nest start --watch
pnpm --filter @open-gateway/api build && pnpm --filter @open-gateway/api start
```

Base path `/api`; health at `GET /api/health`. In the Docker stack it is reached at `https://localhost:33001/api` through the Caddy edge (the container listens on 4000).

| Script | Purpose |
|---|---|
| `dev` / `start:debug` / `build` / `start` | Nest watch mode, debug, build, run `dist/main` |
| `lint` | `eslint "src/**/*.ts" --max-warnings 0` |
| `typecheck` | `tsc --noEmit` |
| `test` / `test:cov` | Jest unit tests (`*.spec.ts`) |
| `test:e2e:*` | Scripts in `test/e2e/*.e2e.mjs`; most `docker cp` into the running `open-gateway-api` container, so the stack must be up |

## Modules

`src/modules/`: auth, tenants, roles, oauth-clients, keys, plans, products, quotas, portal, audit, governance, api-management, api-import, spec-fetch, tyk-integration, analytics, certificates, settings, webhooks, mcp, observability. Shared guards, decorators, Redis and Ory helpers are in `src/common/`.

Conventions every module follows:

- Layering: controller → service (→ repository/Prisma). Business logic stays out of controllers.
- Every tenant-scoped route uses `TenantIsolationGuard` + `PermissionsGuard` with a `@Permissions('resource:action')` code; a caller with no tenant is rejected.
- Input validated with `class-validator` DTOs; responses use the `{ success, data }` / `{ success, error }` envelope.
- Raw SQL only for the pump tables (`tyk_analytics`, `tyk_aggregated`), always parameterised and scoped to the tenant's own Tyk API ids.
- Adding a route means adding its permission to the catalogue, granting it to the roles that need it, and re-seeding.

## Configuration

Environment variables are listed in [docs/reference/configuration.md](../../docs/reference/configuration.md) (`apps/api/.env.example` is the template). `JWT_SECRET` is still demanded by compose but no code reads it.
