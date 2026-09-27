# Library Recommendations — MIRQAB

> Curated list of production-ready JavaScript/TypeScript libraries for this project.
> Goal: avoid reinventing the wheel, minimize boilerplate, maximize reliability.
> Generated: 2026-04-07

---

## Legend

| Symbol | Meaning |
|--------|---------|
| ✅ **Adopt** | Strongly recommended — add to project |
| 🔵 **Consider** | Worth evaluating — add if specific need arises |
| ⏭️ **Skip** | Not needed — project already covers this |
| ❌ **Avoid** | Known issues or conflicts with project goals |

---

## 1. BACKEND (NestJS)

### Authentication & Authorization

| Library | Verdict | Why |
|---------|---------|-----|
| `@nestjs/jwt` | ✅ **Adopted** | Already in project. Standard JWT for NestJS. |
| `@nestjs/passport` | ✅ **Adopted** | Already in project. Passport integration. |
| `passport-jwt` | ✅ **Adopted** | Already in project. JWT strategy. |
| `bcrypt` | ✅ **Adopted** | Already in project. Industry-standard password hashing. |
| `@sclable/nestjs-auth` | 🔵 **Consider** | Drop-in auth module, but our custom auth is already built and more flexible for multi-tenant. |
| `casl` / `@casl/ability` | 🔵 **Consider** | Policy-based authorization. Better than role guards for complex permissions. Could replace our current RBAC for finer-grained control. |
| `@webauthn/server` | 🔵 **Consider** | Passkeys/WebAuthn support for passwordless auth. Phase 2 consideration. |

### Validation & Schemas

| Library | Verdict | Why |
|---------|---------|-----|
| `class-validator` | ✅ **Adopted** | Already in project. NestJS standard for DTO validation. |
| `class-transformer` | ✅ **Adopted** | Already in project. DTO plain-to-class transformation. |
| `zod` | 🔵 **Consider** | Better type inference than class-validator, but switching would require rewriting all DTOs. Consider for new modules only or as an alternative validation path. |
| `zod-error` | 🔵 **Consider** | Human-readable Zod error formatting. Useful if we adopt Zod for frontend→backend validation sharing. |
| `valibot` | ❌ **Avoid** | Too new, ecosystem not mature enough for production enterprise. |
| `arktype` | ❌ **Avoid** | Experimental, not production-ready. |

### Security

| Library | Verdict | Why |
|---------|---------|-----|
| `helmet` | ✅ **Adopted** | Already in project. HTTP security headers. |
| `@nestjs/throttler` | ✅ **Adopted** | Already in project. Rate limiting. |
| `csurf` | 🔵 **Consider** | CSRF protection for cookie-based auth. Our httpOnly cookies are safe from XSS but CSRF is still a vector. |
| `dompurify` / `isomorphic-dompurify` | 🔵 **Consider** | XSS protection if we ever render user HTML. Not needed yet since React auto-escapes. |
| `jose` | 🔵 **Consider** | Modern JWT/JWS/JWE library. More secure than jsonwebtoken for advanced use cases (key rotation, JWE encryption). |
| `rate-limiter-flexible` | 🔵 **Consider** | More advanced rate limiting than @nestjs/throttler — supports Redis backend, sliding windows, per-user limits. |
| `hpp` | ✅ **Adopt** | HTTP Parameter Pollution protection. Single middleware addition. |
| `xss-clean` | 🔵 **Consider** | Request body sanitization. Lightweight, one-line middleware. |

### Database & ORM

| Library | Verdict | Why |
|---------|---------|-----|
| `@prisma/client` | ✅ **Adopted** | Already in project. Type-safe ORM. |
| `prisma` | ✅ **Adopted** | Already in project. CLI, migrations. |
| `prisma-extension-pagination` | 🔵 **Consider** | Adds `.paginate()` to Prisma client. Replaces our manual pagination logic. |
| `prisma-json-schema-generator` | 🔵 **Consider** | Generates JSON Schema from Prisma schema. Useful for OpenAPI docs. |

### Caching & Redis

| Library | Verdict | Why |
|---------|---------|-----|
| `ioredis` | ✅ **Adopted** | Already in project. Best Redis client for Node.js. |
| `@nestjs/cache-manager` | 🔵 **Consider** | NestJS official caching abstraction. Could replace our custom cache interceptor with a standard one. Supports multiple stores (Redis, in-memory). |
| `cache-manager` | 🔵 **Consider** | Multi-layer caching (L1 in-memory + L2 Redis). Good for high-traffic scenarios. |
| `keyv` | ❌ **Skip** | Simpler alternative to cache-manager, but ioredis + custom interceptor is sufficient. |

### Circuit Breaker & Resilience

| Library | Verdict | Why |
|---------|---------|-----|
| **Custom (built)** | ✅ **Adopted** | Already built in-project. Simple, no extra dependency. |
| `cockatiel` | 🔵 **Consider** | Microsoft's resilience library — circuit breaker, retry, timeout, bulkhead patterns. More battle-tested than our custom implementation. **Recommended to replace custom circuit breaker.** |
| `opossum` | ❌ **Skip** | Heavier than cockatiel, similar functionality. |
| `p-retry` | 🔵 **Consider** | Simple retry with exponential backoff. Could simplify our retry logic in Tyk sync. |
| `p-limit` | 🔵 **Consider** | Concurrency limiter. Useful for batch operations. |

### HTTP & API Clients

| Library | Verdict | Why |
|---------|---------|-----|
| Native `fetch` | ✅ **Adopted** | Already used for Tyk client. No extra dependency needed. |
| `ky` | 🔵 **Consider** | Better Fetch wrapper — built-in retry, timeout, hooks, JSON parsing. Could replace raw fetch in TykClientService for cleaner code. |
| `axios` | ❌ **Skip** | Heavier than fetch/ky. Not needed since we use native fetch. |
| `undici` | 🔵 **Consider** | Faster HTTP client than native fetch. Consider if Tyk API calls become a bottleneck. |

### Logging & Observability

| Library | Verdict | Why |
|---------|---------|-----|
| `@opentelemetry/sdk-node` | ✅ **Adopted** | Already in project dependencies. |
| `nestjs-pino` + `pino` | 🔵 **Consider** | Structured JSON logging with auto-correlation IDs. Better than NestJS default logger for production. Integrates with Pino ecosystem (Loki, Datadog). |
| `pino-pretty` | 🔵 **Consider** | Human-readable Pino logs in development. |
| `nestjs-otel` | 🔵 **Consider** | Official NestJS OpenTelemetry integration. Auto-instruments controllers, services, guards. |
| `@nestjs/terminus` | ✅ **Adopt** | Health checks library. Standard NestJS health check patterns (DB, Redis, Tyk connectivity). |

### Scheduling & Background Jobs

| Library | Verdict | Why |
|---------|---------|-----|
| `@nestjs/schedule` + `@nestjs/bullmq` | ✅ **Adopt** | Cron jobs (health checks, quota resets) and job queues (Tyk sync retries). BullMQ uses Redis — already available. |
| `bullmq` | ✅ **Adopt** | Already included via @nestjs/bullmq. Redis-backed job queue for reliable async operations. |
| `cron` | ❌ **Skip** | @nestjs/schedule wraps this. |

### Error Handling

| Library | Verdict | Why |
|---------|---------|-----|
| **Custom (built)** | ✅ **Adopted** | All-exceptions filter already built. |
| `neverthrow` | 🔵 **Consider** | Result type for explicit error handling. Could improve Tyk sync error handling but conflicts with NestJS exception pattern. |
| `ts-results` | ❌ **Skip** | Same as neverthrow, less popular. |
| `http-errors` | ❌ **Skip** | Express-specific, NestJS has built-in HttpException. |

### API Documentation

| Library | Verdict | Why |
|---------|---------|-----|
| `@nestjs/swagger` | ✅ **Adopted** | Already in project dependencies. Auto-generates OpenAPI docs from decorators. |
| `@anatine/zod-nestjs-swagger` | 🔵 **Consider** | Generates Swagger from Zod schemas. Useful if we adopt Zod. |

---

## 2. FRONTEND (Next.js)

### UI Components & Styling

| Library | Verdict | Why |
|---------|---------|-----|
| `tailwindcss` | ✅ **Adopted** | Already in project. Utility-first CSS. |
| `shadcn/ui` | ✅ **Adopted** | Already planned. Copy-paste components, full control. |
| `@radix-ui/react-*` | ✅ **Adopted** | Underlying primitives for shadcn/ui. Accessible, unstyled. |
| `class-variance-authority` (cva) | ✅ **Adopt** | Component variants for shadcn/ui. Standard pattern. |
| `clsx` + `tailwind-merge` | ✅ **Adopt** | Already planned. Conditional classes + merge conflicts. |
| `lucide-react` | ✅ **Adopt** | Already used in plan. Modern icon library, tree-shakeable. |
| `cmdk` | 🔵 **Consider** | Command palette (Cmd+K). Great for admin dashboards — quick navigation, search actions. |
| `sonner` | 🔵 **Consider** | Toast notifications. Better than shadcn/ui default toast — promise toasts, swipe dismiss, action buttons. |

### Forms & Validation

| Library | Verdict | Why |
|---------|---------|-----|
| `react-hook-form` | ✅ **Adopted** | Already in project. Best-in-class form performance. |
| `zod` | ✅ **Adopt** | Form validation + schema sharing with backend. `@hookform/resolvers` bridges RHF + Zod. |
| `@hookform/resolvers` | ✅ **Adopt** | Already planned. Zod resolver for React Hook Form. |
| `react-json-schema-form` / `@rjsf/core` | 🔵 **Consider** | Auto-generate forms from JSON Schema. Useful for dynamic API config forms where fields vary per API type. |
| `use-form` / `@mantine/form` | ❌ **Skip** | React Hook Form is superior for our use case. |

### Data Tables

| Library | Verdict | Why |
|---------|---------|-----|
| `@tanstack/react-table` | ✅ **Adopted** | Already in project. Headless, fully customizable. |
| `@tanstack/react-query` | ✅ **Adopted** | Already in project. Server state management. |
| `@tanstack/react-query-devtools` | ✅ **Adopt** | Dev-only debugging panel for TanStack Query. Invaluable for debugging cache/queries. |
| `@tanstack/react-virtual` | 🔵 **Consider** | Virtual scrolling for large tables (>1000 rows). Needed if we have large API/key lists. |

### State Management

| Library | Verdict | Why |
|---------|---------|-----|
| `@tanstack/react-query` | ✅ **Adopted** | Already in project. Covers all server state needs. |
| `zustand` | 🔵 **Consider** | Lightweight client state (sidebar collapse, tenant selector, theme). Simpler than Context + useReducer. Only needed if we have significant client-only state. |
| `jotai` | ❌ **Skip** | Zustand is simpler and covers the same use case. |
| `immer` + `use-immer` | 🔵 **Consider** | Immutable state management. Only needed if we have complex nested state. |
| `valtio` | ❌ **Skip** | Proxy-based state. Zustand is simpler. |

### Date & Time

| Library | Verdict | Why |
|---------|---------|-----|
| `date-fns` | ✅ **Adopt** | Functional, tree-shakeable, TypeScript-native. Best choice for date formatting in tables, audit logs, analytics. |
| `dayjs` | ❌ **Skip** | date-fns is more TypeScript-native and has better tree-shaking. |
| `@date-fns/tz` | 🔵 **Consider** | Timezone support for multi-region deployments. |
| `react-day-picker` | 🔵 **Consider** | Date picker component. Used by shadcn/ui Calendar component. Already covered if we use shadcn/ui Calendar. |

### Charts & Visualization

| Library | Verdict | Why |
|---------|---------|-----|
| `recharts` | ✅ **Adopt** | React-native charting library. Composable, customizable. shadcn/ui Chart uses Recharts. |
| `@nivo/core` | 🔵 **Consider** | Beautiful charts, but heavier than Recharts. Consider if we need more complex visualizations. |
| `chart.js` + `react-chartjs-2` | ❌ **Skip** | Canvas-based, harder to customize. Recharts is SVG-based and composable. |

### HTTP Client

| Library | Verdict | Why |
|---------|---------|-----|
| Native `fetch` + TanStack Query | ✅ **Adopted** | Already planned. No extra HTTP library needed — TanStack Query handles caching, retries, pagination. |
| `ky` | 🔵 **Consider** | If we need retries, timeouts, or hooks beyond what our fetch wrapper provides. |
| `axios` | ❌ **Skip** | Heavier than fetch. TanStack Query handles what we'd use Axios for. |

### Utilities

| Library | Verdict | Why |
|---------|---------|-----|
| `es-toolkit` | ✅ **Adopt** | Modern Lodash replacement. 97% smaller bundle, TypeScript-native. For array/object manipulation utilities. |
| `nanoid` | ✅ **Adopt** | Tiny ID generator. Already covered by Prisma UUID defaults, but useful for client-side IDs (form keys, list keys). |
| `type-fest` | ✅ **Adopt** | Essential TypeScript utility types (SetRequired, PartialDeep, Jsonify, etc.). Fills TS gaps. |
| `ts-pattern` | 🔵 **Consider** | Pattern matching for discriminated unions. Useful for complex state machines or API response handling. |
| `tiny-invariant` | ✅ **Adopt** | Assertion helper with type narrowing. Cleaner than manual `if (!x) throw` patterns. |
| `zodios` | ❌ **Skip** | Type-safe API client, but TanStack Query + shared types covers this. |
| `superjson` | ❌ **Skip** | Only needed for tRPC-style serialization. Not relevant for our REST API. |
| `next-themes` | ✅ **Adopt** | Already planned. Theme provider for light/dark mode. |

### Accessibility

| Library | Verdict | Why |
|---------|---------|-----|
| `@radix-ui/*` | ✅ **Adopted** | Already used via shadcn/ui. Full keyboard navigation, ARIA, focus management. |
| `axe-core` / `@axe-core/react` | 🔵 **Consider** | Accessibility testing in development. Catches a11y violations during dev. |

---

## 3. INFRASTRUCTURE & DEVOPS

### Testing

| Library | Verdict | Why |
|---------|---------|-----|
| `jest` | ✅ **Adopted** | Already in project. Standard for NestJS. |
| `@nestjs/testing` | ✅ **Adopted** | Already in project. NestJS testing utilities. |
| `testcontainers` | ✅ **Adopt** | Spin up real PostgreSQL/Redis containers for integration tests. Better than mocks for DB testing. |
| `@testing-library/react` | ✅ **Adopt** | Standard for React component testing. |
| `@testing-library/jest-dom` | ✅ **Adopt** | Custom Jest matchers for DOM testing. |
| `@testing-library/user-event` | ✅ **Adopt** | Realistic user interaction simulation for React tests. |
| `msw` (Mock Service Worker) | ✅ **Adopt** | API mocking at network level. Better than fetch mocks — works with TanStack Query naturally. |
| `playwright` | ✅ **Adopt** | E2E testing. Industry standard. |
| `vitest` | ❌ **Skip** | Jest is already configured and works with NestJS. Switching would add complexity. |
| `supertest` | 🔵 **Consider** | HTTP assertion testing for NestJS endpoints. NestJS testing module covers most of this though. |

### Docker & Infrastructure

| Library | Verdict | Why |
|---------|---------|-----|
| `docker compose` | ✅ **Adopted** | Already in project. Local dev infrastructure. |
| `testcontainers` | ✅ **Adopt** | Integration tests with real DB/Redis. |
| `pg` | ✅ **Adopt** | PostgreSQL driver. Used by Prisma internally. |

### CI/CD & Code Quality

| Library | Verdict | Why |
|---------|---------|-----|
| `husky` + `lint-staged` | ✅ **Adopt** | Git hooks for pre-commit linting and formatting. |
| `commitlint` | 🔵 **Consider** | Enforce conventional commits. Useful for automated changelogs and semantic versioning. |
| `changesets` | 🔵 **Consider** | Version management for monorepo packages. Useful if we publish packages. |
| `knip` | 🔵 **Consider** | Find unused exports, files, and dependencies. Keeps monorepo clean. |
| `publint` | 🔵 **Consider** | Lint package.json for common issues in workspace packages. |

---

## 4. RECOMMENDED ADOPTION PRIORITY

### Phase 1 (Add Immediately — Foundation)

```bash
# Backend
pnpm add @nestjs/schedule @nestjs/bullmq bullmq
pnpm add @nestjs/terminus
pnpm add hpp
pnpm add cockatiel
pnpm add nestjs-pino pino pino-pretty
pnpm add -D @nestjs/testing jest @types/jest

# Frontend
pnpm add zod @hookform/resolvers
pnpm add date-fns
pnpm add recharts
pnpm add next-themes
pnpm add class-variance-authority clsx tailwind-merge
pnpm add lucide-react
pnpm add es-toolkit
pnpm add type-fest
pnpm add nanoid
pnpm add tiny-invariant
pnpm add sonner
pnpm add cmdk

# Dev/Testing
pnpm add -D @testing-library/react @testing-library/jest-dom @testing-library/user-event
pnpm add -D msw
pnpm add -D playwright
pnpm add -D testcontainers
pnpm add -D husky lint-staged
```

### Phase 2 (Add When Needed)

- `casl` — when RBAC needs to become policy-based
- `@nestjs/cache-manager` — when caching needs abstraction
- `ky` — if Tyk client needs more HTTP features
- `@tanstack/react-virtual` — if tables exceed performance
- `zustand` — if client state grows complex
- `rate-limiter-flexible` — if per-user rate limiting needed
- `@date-fns/tz` — if multi-region timezone support needed
- `msw` — when frontend API mocking needed for dev
- `testcontainers` — when integration tests need real DB
- `jose` — if JWT key rotation or JWE needed
- `@rjsf/core` — if dynamic config forms needed
- `commitlint` — when enforcing commit conventions
- `knip` — when monorepo needs unused code detection

### Phase 3 (Evaluate for Scale)

- `@webauthn/server` — passkeys
- `@nivo/core` — advanced charts
- `Effect` — if we need comprehensive typed error handling framework
- `neverthrow` — if we want explicit Result types

---

## 5. LIBRARIES TO AVOID

| Library | Reason |
|---------|--------|
| `moment.js` | Dead project, huge bundle, mutable dates |
| `lodash` (full) | es-toolkit is 97% smaller with same API |
| `axios` | Native fetch + TanStack Query covers all needs |
| `redux` / `@reduxjs/toolkit` | Overkill — TanStack Query + optional Zustand covers everything |
| `styled-components` / `emotion` | Conflicts with Tailwind/shadcn/ui approach |
| `formik` | React Hook Form is faster and has better DX |
| `yup` | Zod has superior TypeScript type inference |
| `redux-saga` / `redux-thunk` | Irrelevant without Redux |
| `graphql` / `@apollo/client` | We're using REST, not GraphQL |
| `socket.io` | Overkill — use native WebSocket API if needed |
| `sequelize` / `typeorm` | Prisma is already chosen and superior DX |
| `mongoose` | We're using PostgreSQL, not MongoDB |
| `faker` / `@faker-js/faker` | Use testcontainers with real seeded data instead |

---

## 6. CURRENT vs RECOMMENDED DEPENDENCY AUDIT

### Already in Project (Correct)

```json
{
  "backend": [
    "@nestjs/common", "@nestjs/core", "@nestjs/platform-express",
    "@nestjs/config", "@nestjs/jwt", "@nestjs/passport",
    "@nestjs/swagger", "@nestjs/throttler",
    "@opentelemetry/api", "@opentelemetry/sdk-node", "@opentelemetry/instrumentation-http",
    "@prisma/client", "prisma",
    "bcrypt", "class-validator", "class-transformer",
    "cookie-parser", "helmet", "ioredis",
    "passport", "passport-jwt",
    "reflect-metadata", "rxjs"
  ],
  "frontend": [
    "next", "react", "react-dom",
    "typescript", "tailwindcss",
    "@tanstack/react-query", "@tanstack/react-table", "@tanstack/react-query-devtools",
    "react-hook-form", "zod",
    "clsx", "tailwind-merge"
  ],
  "dev": [
    "turbo", "prettier", "eslint", "typescript-eslint",
    "jest", "ts-jest",
    "@types/node", "@types/jest", "@types/bcrypt"
  ]
}
```

### Missing (Should Add — Phase 1)

```json
{
  "backend": [
    "@nestjs/schedule", "@nestjs/bullmq", "bullmq",
    "@nestjs/terminus",
    "nestjs-pino", "pino", "pino-pretty",
    "cockatiel",
    "hpp"
  ],
  "frontend": [
    "date-fns",
    "recharts",
    "next-themes",
    "class-variance-authority",
    "lucide-react",
    "es-toolkit",
    "type-fest",
    "nanoid",
    "tiny-invariant",
    "sonner",
    "cmdk",
    "@radix-ui/react-dialog",
    "@radix-ui/react-dropdown-menu",
    "@radix-ui/react-slot",
    "@radix-ui/react-separator",
    "@radix-ui/react-tooltip",
    "@radix-ui/react-label",
    "@radix-ui/react-toast",
    "@radix-ui/react-switch",
    "@radix-ui/react-select",
    "@radix-ui/react-popover",
    "@radix-ui/react-tabs",
    "@radix-ui/react-avatar",
    "@radix-ui/react-scroll-area",
    "@radix-ui/react-collapsible",
    "@radix-ui/react-navigation-menu",
    "@radix-ui/react-menubar",
    "@hookform/resolvers"
  ],
  "dev": [
    "@testing-library/react", "@testing-library/jest-dom", "@testing-library/user-event",
    "msw",
    "playwright",
    "testcontainers",
    "husky", "lint-staged"
  ]
}
```

---

*End of Library Recommendations*
